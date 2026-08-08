/**
 * World persistence.
 *
 * Worlds are stored in IndexedDB as three stores:
 *
 *   worlds   one record of metadata per save
 *   chunks   the *edit list* for each modified chunk, keyed [world, cx, cz]
 *   players  position, inventory and clock, one record per save
 *
 * Only edits are stored, never generated terrain: the generator is a pure
 * function of (seed, position), so regenerating is both faster and smaller than
 * reading blocks back off disk. A world the player has only walked through
 * saves as a few hundred bytes.
 *
 * Everything degrades to an in-memory store if IndexedDB is unavailable, so the
 * game still runs in private browsing — it just forgets worlds on reload.
 */

const DB_NAME = 'voxel-sandbox';
const DB_VERSION = 1;

const STORE_WORLDS = 'worlds';
const STORE_CHUNKS = 'chunks';
const STORE_PLAYERS = 'players';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_WORLDS)) {
        db.createObjectStore(STORE_WORLDS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS, { keyPath: ['world', 'cx', 'cz'] });
      }
      if (!db.objectStoreNames.contains(STORE_PLAYERS)) {
        db.createObjectStore(STORE_PLAYERS, { keyPath: 'world' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * All chunk records for one world.
 *
 * Compound keys sort element-wise and an array sorts after every scalar, so
 * `[id]` .. `[id, []]` is exactly the range of keys belonging to this world.
 */
function worldChunkRange(worldId) {
  return IDBKeyRange.bound([worldId], [worldId, []], false, true);
}

export class WorldStore {
  constructor(db) {
    this.db = db;
    /** Populated instead of `db` when IndexedDB could not be opened. */
    this.memory = db ? null : { worlds: new Map(), chunks: new Map(), players: new Map() };
  }

  static async open() {
    try {
      return new WorldStore(await openDatabase());
    } catch (error) {
      console.warn('[storage] falling back to in-memory saves:', error.message);
      return new WorldStore(null);
    }
  }

  get isPersistent() {
    return this.db !== null;
  }

  transaction(stores, mode) {
    return this.db.transaction(stores, mode);
  }

  // -------------------------------------------------------------------------
  // World metadata
  // -------------------------------------------------------------------------

  async listWorlds() {
    if (this.memory) {
      return [...this.memory.worlds.values()].sort((a, b) => b.updated - a.updated);
    }
    const tx = this.transaction([STORE_WORLDS], 'readonly');
    const all = await promisify(tx.objectStore(STORE_WORLDS).getAll());
    return all.sort((a, b) => b.updated - a.updated);
  }

  async getWorld(id) {
    if (this.memory) return this.memory.worlds.get(id) ?? null;
    const tx = this.transaction([STORE_WORLDS], 'readonly');
    return (await promisify(tx.objectStore(STORE_WORLDS).get(id))) ?? null;
  }

  async putWorld(meta) {
    const record = { ...meta, updated: Date.now() };
    if (this.memory) {
      this.memory.worlds.set(record.id, record);
      return record;
    }
    const tx = this.transaction([STORE_WORLDS], 'readwrite');
    await promisify(tx.objectStore(STORE_WORLDS).put(record));
    return record;
  }

  async deleteWorld(id) {
    if (this.memory) {
      this.memory.worlds.delete(id);
      this.memory.players.delete(id);
      for (const key of [...this.memory.chunks.keys()]) {
        if (key.startsWith(`${id}:`)) this.memory.chunks.delete(key);
      }
      return;
    }
    const tx = this.transaction([STORE_WORLDS, STORE_CHUNKS, STORE_PLAYERS], 'readwrite');
    tx.objectStore(STORE_WORLDS).delete(id);
    tx.objectStore(STORE_PLAYERS).delete(id);
    tx.objectStore(STORE_CHUNKS).delete(worldChunkRange(id));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // -------------------------------------------------------------------------
  // Chunk edits
  // -------------------------------------------------------------------------

  /**
   * Load every edited chunk for a world into a map keyed `"cx,cz"`.
   *
   * Reading the whole set up front is what keeps chunk generation synchronous:
   * the generator can apply edits inline instead of every chunk needing to wait
   * on a database round trip mid-stream.
   */
  async loadEdits(worldId) {
    const map = new Map();
    if (this.memory) {
      for (const [key, record] of this.memory.chunks) {
        if (key.startsWith(`${worldId}:`)) map.set(`${record.cx},${record.cz}`, record);
      }
      return map;
    }
    const tx = this.transaction([STORE_CHUNKS], 'readonly');
    const records = await promisify(tx.objectStore(STORE_CHUNKS).getAll(worldChunkRange(worldId)));
    for (const record of records) map.set(`${record.cx},${record.cz}`, record);
    return map;
  }

  /** Write a batch of chunk edit lists in one transaction. */
  async saveEdits(worldId, entries) {
    if (entries.length === 0) return;
    if (this.memory) {
      for (const entry of entries) {
        this.memory.chunks.set(`${worldId}:${entry.cx},${entry.cz}`, { world: worldId, ...entry });
      }
      return;
    }
    const tx = this.transaction([STORE_CHUNKS], 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    for (const entry of entries) store.put({ world: worldId, ...entry });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // -------------------------------------------------------------------------
  // Player state
  // -------------------------------------------------------------------------

  async loadPlayer(worldId) {
    if (this.memory) return this.memory.players.get(worldId) ?? null;
    const tx = this.transaction([STORE_PLAYERS], 'readonly');
    return (await promisify(tx.objectStore(STORE_PLAYERS).get(worldId))) ?? null;
  }

  async savePlayer(worldId, data) {
    const record = { world: worldId, ...data };
    if (this.memory) {
      this.memory.players.set(worldId, record);
      return;
    }
    const tx = this.transaction([STORE_PLAYERS], 'readwrite');
    await promisify(tx.objectStore(STORE_PLAYERS).put(record));
  }

  /** Rough on-disk size of a world, for the world list. */
  async estimateSize(worldId) {
    const edits = await this.loadEdits(worldId);
    let blocks = 0;
    for (const record of edits.values()) blocks += record.keys.length;
    return { chunks: edits.size, blocks };
  }
}

/** Stable, sortable, human-typable id for a new save. */
export function makeWorldId() {
  const stamp = Date.now().toString(36);
  const salt = Math.floor(Math.random() * 0xffff).toString(36).padStart(4, '0');
  return `w-${stamp}-${salt}`;
}
