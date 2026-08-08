/**
 * Incremental, cross-chunk light updates.
 *
 * `lighting.js` computes a chunk's light in isolation, which is right for
 * generation but wrong for two things a playable world needs:
 *
 *  - Light must cross chunk borders. A torch placed two blocks from a seam
 *    would otherwise stop in a perfectly straight line down the boundary.
 *  - A single block edit must not cost a full-column recompute. Relighting
 *    16x16x256 for one placed torch is milliseconds of stall per click.
 *
 * Both are solved by the classic two-phase flood: first walk outward removing
 * the light that the old block was responsible for, collecting the cells that
 * are *brighter* than the removal front as re-propagation seeds, then flood
 * those seeds back out. Every read and write goes through world coordinates, so
 * the flood crosses chunks without knowing it did.
 */

import { CHUNK_SIZE, WORLD_HEIGHT, MAX_LIGHT, SECTION_HEIGHT } from './constants.js';
import { AIR } from './blocks.js';

const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
/** Index into NEIGHBORS of the straight-down direction. */
const DOWN = 3;

/** Growable queue of (x, y, z, level) tuples with no per-entry allocation. */
class LightQueue {
  constructor(capacity = 1 << 12) {
    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.z = new Int32Array(capacity);
    this.v = new Int32Array(capacity);
    this.head = 0;
    this.tail = 0;
  }

  reset() {
    this.head = 0;
    this.tail = 0;
  }

  get isEmpty() {
    return this.head === this.tail;
  }

  push(x, y, z, v) {
    if (this.tail === this.x.length) {
      if (this.head > this.x.length >> 1) {
        // Front has drained: compact instead of doubling.
        this.x.copyWithin(0, this.head, this.tail);
        this.y.copyWithin(0, this.head, this.tail);
        this.z.copyWithin(0, this.head, this.tail);
        this.v.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      } else {
        const size = this.x.length * 2;
        for (const key of ['x', 'y', 'z', 'v']) {
          const next = new Int32Array(size);
          next.set(this[key]);
          this[key] = next;
        }
      }
    }
    this.x[this.tail] = x;
    this.y[this.tail] = y;
    this.z[this.tail] = z;
    this.v[this.tail] = v;
    this.tail++;
  }
}

export class LightPropagator {
  /** @param {import('./world.js').World} world */
  constructor(world) {
    this.world = world;
    this.removeQueue = new LightQueue();
    this.addQueue = new LightQueue();
    /** Chunks whose geometry needs rebuilding after the current update. */
    this.touched = new Set();

    // Single-entry chunk memo. A flood is spatially coherent, so consecutive
    // cells almost always land in the same chunk; without this, every read and
    // write builds a `"cx,cz"` string to probe the chunk map.
    this._cacheX = Number.NaN;
    this._cacheZ = Number.NaN;
    this._cacheChunk = null;
  }

  get tables() {
    return this.world.tables;
  }

  /** Reset the memo. Call before any operation that may span new chunks. */
  invalidateCache() {
    this._cacheX = Number.NaN;
    this._cacheZ = Number.NaN;
    this._cacheChunk = null;
  }

  chunkAt(wx, wz) {
    const cx = wx >> 4;
    const cz = wz >> 4;
    if (cx === this._cacheX && cz === this._cacheZ) return this._cacheChunk;
    const chunk = this.world.getChunk(cx, cz);
    this._cacheX = cx;
    this._cacheZ = cz;
    this._cacheChunk = chunk;
    return chunk;
  }

  getLight(wx, wy, wz, isSky) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return isSky && wy >= WORLD_HEIGHT ? MAX_LIGHT : 0;
    const chunk = this.chunkAt(wx, wz);
    if (!chunk) return 0;
    return isSky
      ? chunk.getSkyLight(wx & 15, wy, wz & 15)
      : chunk.getBlockLight(wx & 15, wy, wz & 15);
  }

  setLight(wx, wy, wz, level, isSky) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return;
    const chunk = this.chunkAt(wx, wz);
    if (!chunk) return;
    const lx = wx & 15;
    const lz = wz & 15;
    if (isSky) chunk.setSkyLight(lx, wy, lz, level);
    else chunk.setBlockLight(lx, wy, lz, level);

    chunk.markDirtyAround(wy);
    this.touched.add(chunk);

    // A changed cell on a chunk seam also changes the neighbour's border
    // samples, so its mesh is stale too.
    if (lx === 0) this.markSeam(chunk.cx - 1, chunk.cz, wy);
    else if (lx === CHUNK_SIZE - 1) this.markSeam(chunk.cx + 1, chunk.cz, wy);
    if (lz === 0) this.markSeam(chunk.cx, chunk.cz - 1, wy);
    else if (lz === CHUNK_SIZE - 1) this.markSeam(chunk.cx, chunk.cz + 1, wy);
  }

  markSeam(cx, cz, wy) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) return;
    chunk.markDirtyAround(wy);
    this.touched.add(chunk);
  }

  /** How much light costs to enter this block, or -1 if it cannot. */
  transmission(id) {
    if (id === AIR) return 1;
    const filter = this.tables.lightFilter[id];
    if (filter >= MAX_LIGHT) return -1;
    return Math.max(1, filter);
  }

  // -------------------------------------------------------------------------
  // Block edits
  // -------------------------------------------------------------------------

  /**
   * Bring lighting back into agreement after one block changed.
   * Returns the set of chunks whose meshes were invalidated.
   */
  applyBlockChange(wx, wy, wz, previousId, nextId) {
    this.touched.clear();
    this.invalidateCache();

    this.updateBlockLight(wx, wy, wz, previousId, nextId);
    this.updateSkyLight(wx, wy, wz, previousId, nextId);

    return this.touched;
  }

  /**
   * Both channels follow the same two-phase shape: tear down whatever the old
   * block was responsible for, then rebuild from the sources that survive.
   * Running them as two separate floods rather than one interleaved pass keeps
   * the invariant simple — nothing added in phase two can be torn down again.
   */
  updateBlockLight(wx, wy, wz, previousId, nextId) {
    const nextEmission = this.tables.lightLevel[nextId];
    const previousEmission = this.tables.lightLevel[previousId];
    const previousTransmission = this.transmission(previousId);
    const nextTransmission = this.transmission(nextId);

    // Nothing about how this block emits or transmits changed.
    if (previousEmission === nextEmission && previousTransmission === nextTransmission) return;

    const existing = this.getLight(wx, wy, wz, false);

    this.removeQueue.reset();
    this.addQueue.reset();
    if (existing > 0) {
      this.setLight(wx, wy, wz, 0, false);
      this.removeQueue.push(wx, wy, wz, existing);
    }
    this.flood(false);

    this.removeQueue.reset();
    this.addQueue.reset();
    if (nextEmission > 0) {
      this.setLight(wx, wy, wz, nextEmission, false);
      this.addQueue.push(wx, wy, wz, nextEmission);
    }
    if (nextTransmission >= 0) {
      for (const [dx, dy, dz] of NEIGHBORS) {
        const level = this.getLight(wx + dx, wy + dy, wz + dz, false);
        if (level > 1) this.addQueue.push(wx + dx, wy + dy, wz + dz, level);
      }
    }
    this.flood(false);
  }

  updateSkyLight(wx, wy, wz, previousId, nextId) {
    const previousFilter = this.tables.lightFilter[previousId];
    const nextFilter = this.tables.lightFilter[nextId];
    // Skylight depends only on how much a block blocks, so an edit that does
    // not change the filter cannot change the skylight anywhere.
    if (previousFilter === nextFilter) return;

    const existing = this.getLight(wx, wy, wz, true);

    this.removeQueue.reset();
    this.addQueue.reset();
    if (existing > 0) {
      this.setLight(wx, wy, wz, 0, true);
      this.removeQueue.push(wx, wy, wz, existing);
      // A new blocker also cancels the free-falling daylight shaft beneath it.
      if (existing >= MAX_LIGHT && nextFilter > 0) this.removeSkyColumn(wx, wy - 1, wz);
    }
    this.flood(true);

    this.removeQueue.reset();
    this.addQueue.reset();
    if (this.transmission(nextId) >= 0) {
      if (this.isOpenToSky(wx, wy, wz)) {
        this.setLight(wx, wy, wz, MAX_LIGHT, true);
        this.addQueue.push(wx, wy, wz, MAX_LIGHT);
      }
      for (const [dx, dy, dz] of NEIGHBORS) {
        const level = this.getLight(wx + dx, wy + dy, wz + dz, true);
        if (level > 1) this.addQueue.push(wx + dx, wy + dy, wz + dz, level);
      }
    }
    this.flood(true);
  }

  /** Walk down clearing the daylight shaft that a new blocker cut off. */
  removeSkyColumn(wx, wy, wz) {
    for (let y = wy; y >= 0; y--) {
      const level = this.getLight(wx, y, wz, true);
      if (level < MAX_LIGHT) break;
      this.setLight(wx, y, wz, 0, true);
      this.removeQueue.push(wx, y, wz, MAX_LIGHT);
      if (this.transmission(this.world.getBlock(wx, y, wz)) < 0) break;
    }
  }

  /** True if nothing between this block and the sky blocks light. */
  isOpenToSky(wx, wy, wz) {
    const chunk = this.chunkAt(wx, wz);
    if (!chunk) return false;
    for (let y = wy + 1; y < WORLD_HEIGHT; y++) {
      const id = chunk.getBlock(wx & 15, y, wz & 15);
      if (id === AIR) continue;
      if (this.tables.lightFilter[id] > 0) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Flood
  // -------------------------------------------------------------------------

  /** Run removal to exhaustion, then propagation. */
  flood(isSky) {
    const remove = this.removeQueue;
    while (!remove.isEmpty) {
      const i = remove.head++;
      const x = remove.x[i];
      const y = remove.y[i];
      const z = remove.z[i];
      const level = remove.v[i];

      for (let d = 0; d < 6; d++) {
        const nx = x + NEIGHBORS[d][0];
        const ny = y + NEIGHBORS[d][1];
        const nz = z + NEIGHBORS[d][2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;

        const neighborLevel = this.getLight(nx, ny, nz, isSky);
        if (neighborLevel === 0) continue;

        // Free-falling daylight keeps its level, so a cell directly below a
        // removed one at full strength is part of the same shaft, not a
        // brighter independent source.
        const inherited = isSky && d === DOWN && level >= MAX_LIGHT;

        if (neighborLevel < level || inherited) {
          this.setLight(nx, ny, nz, 0, isSky);
          remove.push(nx, ny, nz, neighborLevel);
        } else {
          // Brighter than the front: it is a real source, re-flood from it.
          this.addQueue.push(nx, ny, nz, neighborLevel);
        }
      }
    }

    const add = this.addQueue;
    while (!add.isEmpty) {
      const i = add.head++;
      const x = add.x[i];
      const y = add.y[i];
      const z = add.z[i];
      const level = this.getLight(x, y, z, isSky);
      if (level <= 1) continue;

      for (let d = 0; d < 6; d++) {
        const nx = x + NEIGHBORS[d][0];
        const ny = y + NEIGHBORS[d][1];
        const nz = z + NEIGHBORS[d][2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;

        const cost = this.transmission(this.world.getBlock(nx, ny, nz));
        if (cost < 0) continue;

        // Daylight falls straight down without attenuating, so a shaft of sun
        // reaches the bottom of a hole at full strength.
        const step = isSky && d === DOWN && cost === 1 ? 0 : cost;
        const next = level - step;
        if (next <= 0) continue;
        if (this.getLight(nx, ny, nz, isSky) >= next) continue;

        this.setLight(nx, ny, nz, next, isSky);
        add.push(nx, ny, nz, next);
      }
    }

    remove.reset();
    add.reset();
  }

  // -------------------------------------------------------------------------
  // Border reconciliation
  // -------------------------------------------------------------------------

  /**
   * Let light cross the seams of a freshly generated chunk.
   *
   * Generation lights each chunk alone, so a cave lit through an opening in the
   * next chunk over comes out dark right up to the boundary. Seeding the
   * propagation queue from every border cell that is brighter than its
   * counterpart fixes the seam in one pass, and costs nothing above the
   * terrain where both sides are already at full daylight.
   */
  reconcileBorders(chunk) {
    this.touched.clear();
    this.invalidateCache();

    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;

    // One pass per channel: the flood is channel-specific, so seeds for the two
    // must never share a queue.
    for (const isSky of [true, false]) {
      this.removeQueue.reset();
      this.addQueue.reset();

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
        if (!neighbor) continue;

        // Only scan up to where one of the two chunks still stores light. Above
        // that both sides read full daylight and can never disagree.
        const top = Math.min(
          WORLD_HEIGHT - 1,
          Math.max(chunk.skySection, neighbor.skySection) * SECTION_HEIGHT + SECTION_HEIGHT,
        );

        for (let t = 0; t < CHUNK_SIZE; t++) {
          const wx = dx === 0 ? baseX + t : baseX + (dx > 0 ? CHUNK_SIZE - 1 : 0);
          const wz = dz === 0 ? baseZ + t : baseZ + (dz > 0 ? CHUNK_SIZE - 1 : 0);
          const ox = wx + dx;
          const oz = wz + dz;

          // Read straight off the two chunk objects. Going through world
          // coordinates here would rebuild a map key for every one of the
          // ~25,000 cells this scan visits per chunk.
          const lx = wx & 15;
          const lz = wz & 15;
          const olx = ox & 15;
          const olz = oz & 15;

          for (let y = 0; y <= top; y++) {
            const here = isSky ? chunk.getSkyLight(lx, y, lz) : chunk.getBlockLight(lx, y, lz);
            const there = isSky
              ? neighbor.getSkyLight(olx, y, olz)
              : neighbor.getBlockLight(olx, y, olz);
            if (here > there + 1) this.addQueue.push(wx, y, wz, here);
            else if (there > here + 1) this.addQueue.push(ox, y, oz, there);
          }
        }
      }

      this.flood(isSky);
    }

    return this.touched;
  }
}
