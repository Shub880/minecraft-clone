/**
 * Chunk storage.
 *
 * A chunk is a 16x16 column split into 16 stacked cubic sections. Sections that
 * contain only air stay `null` rather than allocating 4096 entries, which is
 * what keeps memory flat at large render distances — most of a loaded column is
 * empty sky.
 */

import {
  CHUNK_SIZE,
  SECTION_COUNT,
  SECTION_HEIGHT,
  SECTION_VOLUME,
  WORLD_HEIGHT,
  TINT_STRIDE,
  sectionIndex,
} from './constants.js';
import { AIR } from './blocks.js';

/** Chunk lifecycle, used by the world to decide what work is still owed. */
export const ChunkState = {
  EMPTY: 0,
  GENERATING: 1,
  GENERATED: 2,
  LIT: 3,
  MESHING: 4,
  READY: 5,
};

export class Section {
  constructor() {
    /** Block ids. */
    this.blocks = new Uint16Array(SECTION_VOLUME);
    /** Packed light: high nibble skylight, low nibble blocklight. */
    this.light = new Uint8Array(SECTION_VOLUME);
    /** Count of non-air blocks, so all-air sections can be dropped. */
    this.nonAir = 0;
    /** Bumped whenever contents change, so the mesher knows it is stale. */
    this.version = 0;
  }

  isEmpty() {
    return this.nonAir === 0;
  }
}

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.state = ChunkState.EMPTY;

    /** @type {(Section|null)[]} */
    this.sections = new Array(SECTION_COUNT).fill(null);

    /** Highest non-air block per column, for lighting and spawn placement. */
    this.heightmap = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

    /**
     * Index of the first section with nothing above the terrain in it.
     *
     * Sections at or past this index that were never allocated are open sky, so
     * they can report full skylight without storing it. That is what keeps a
     * loaded chunk to a handful of sections instead of all sixteen: the sky
     * above the ground is most of a column's volume and none of its data.
     */
    this.skySection = 0;

    /** Biome id per column. */
    this.biomes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

    /**
     * Per-column tint: grass, foliage and water RGB. Must match the mesher's
     * TINT_STRIDE of 9 bytes per column.
     */
    this.tint = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * TINT_STRIDE);

    /** Which sections need re-meshing. */
    this.dirtySections = new Set();

    /**
     * Whether light has been allowed to cross this chunk's seams yet. Set the
     * first time the chunk is meshed, which is the earliest point at which all
     * eight neighbours are guaranteed to exist.
     */
    this.bordersLit = false;

    /** Blocks changed by the player, keyed by packed local index. */
    this.edits = new Map();

    /** Three.js meshes per section, keyed by section index. */
    this.meshes = new Map();
  }

  /** Get or create a section, allocating on demand. */
  getOrCreateSection(sy) {
    let section = this.sections[sy];
    if (!section) {
      section = new Section();
      this.sections[sy] = section;
    }
    return section;
  }

  /**
   * Read a block. `x` and `z` are 0..15, `y` is 0..255. Out-of-range y reads as
   * air so callers walking off the top or bottom of the world need no guard.
   */
  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR;
    const section = this.sections[y >> 4];
    if (!section) return AIR;
    return section.blocks[sectionIndex(x, y & 15, z)];
  }

  /** Write a block, allocating the section and maintaining the air count. */
  setBlock(x, y, z, id) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const sy = y >> 4;
    let section = this.sections[sy];
    if (!section) {
      if (id === AIR) return false;
      section = this.getOrCreateSection(sy);
    }

    const index = sectionIndex(x, y & 15, z);
    const previous = section.blocks[index];
    if (previous === id) return false;

    section.blocks[index] = id;
    if (previous === AIR && id !== AIR) section.nonAir++;
    else if (previous !== AIR && id === AIR) section.nonAir--;
    section.version++;

    this.updateHeightmapAfterSet(x, y, z, id);
    return true;
  }

  /**
   * Fast path for generation, which fills sections in bulk and knows the target
   * section already exists. Skips the heightmap update; generation recomputes
   * the whole heightmap once at the end instead.
   */
  setBlockRaw(x, y, z, id) {
    const sy = y >> 4;
    let section = this.sections[sy];
    if (!section) {
      if (id === AIR) return;
      section = this.getOrCreateSection(sy);
    }
    const index = sectionIndex(x, y & 15, z);
    const previous = section.blocks[index];
    if (previous === id) return;
    section.blocks[index] = id;
    if (previous === AIR && id !== AIR) section.nonAir++;
    else if (previous !== AIR && id === AIR) section.nonAir--;
  }

  getSkyLight(x, y, z) {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 15;
    const section = this.sections[y >> 4];
    // An unallocated section is either open sky above the terrain (full light)
    // or a fully hollow pocket below it (dark). `skySection` separates the two.
    if (!section) return (y >> 4) >= this.skySection ? 15 : 0;
    return section.light[sectionIndex(x, y & 15, z)] >> 4;
  }

  /** True if this height's skylight can be inferred instead of stored. */
  isImplicitSky(y) {
    const sy = y >> 4;
    return this.sections[sy] === null && sy >= this.skySection;
  }

  /** Recompute `skySection` from the heightmap. Cheap; call after any relight. */
  updateSkySection() {
    let max = 0;
    for (let i = 0; i < this.heightmap.length; i++) {
      if (this.heightmap[i] > max) max = this.heightmap[i];
    }
    this.skySection = Math.min(SECTION_COUNT, (max >> 4) + 1);
  }

  getBlockLight(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const section = this.sections[y >> 4];
    if (!section) return 0;
    return section.light[sectionIndex(x, y & 15, z)] & 15;
  }

  setSkyLight(x, y, z, level) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const section = this.getOrCreateSection(y >> 4);
    const index = sectionIndex(x, y & 15, z);
    section.light[index] = (section.light[index] & 0x0f) | (level << 4);
  }

  setBlockLight(x, y, z, level) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const section = this.getOrCreateSection(y >> 4);
    const index = sectionIndex(x, y & 15, z);
    section.light[index] = (section.light[index] & 0xf0) | level;
  }

  getHeight(x, z) {
    return this.heightmap[z * CHUNK_SIZE + x];
  }

  getBiome(x, z) {
    return this.biomes[z * CHUNK_SIZE + x];
  }

  /** Recompute the full heightmap. Called once after generation. */
  rebuildHeightmap(opaqueTable) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        let height = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const id = this.getBlock(x, y, z);
          if (id !== AIR && opaqueTable[id]) {
            height = y + 1;
            break;
          }
        }
        this.heightmap[z * CHUNK_SIZE + x] = Math.min(255, height);
      }
    }
  }

  /** Cheap incremental heightmap fix for a single edit. */
  updateHeightmapAfterSet(x, y, z, id) {
    const i = z * CHUNK_SIZE + x;
    const current = this.heightmap[i];
    if (id !== AIR && y + 1 > current) {
      this.heightmap[i] = Math.min(255, y + 1);
    } else if (id === AIR && y + 1 === current) {
      let height = 0;
      for (let scan = y; scan >= 0; scan--) {
        if (this.getBlock(x, scan, z) !== AIR) {
          height = scan + 1;
          break;
        }
      }
      this.heightmap[i] = height;
    }
  }

  markSectionDirty(sy) {
    if (sy >= 0 && sy < SECTION_COUNT) this.dirtySections.add(sy);
  }

  /** Mark the sections touched by an edit at local y, including neighbours. */
  markDirtyAround(y) {
    const sy = y >> 4;
    this.markSectionDirty(sy);
    // An edit on a section boundary changes the neighbour's visible faces too.
    if ((y & 15) === 0) this.markSectionDirty(sy - 1);
    if ((y & 15) === SECTION_HEIGHT - 1) this.markSectionDirty(sy + 1);
  }

  /** True if every section is air, so the column can be skipped entirely. */
  isEmpty() {
    for (const section of this.sections) {
      if (section && !section.isEmpty()) return false;
    }
    return true;
  }

  /**
   * Serialise only what differs from generation output. A freshly generated
   * chunk saves as nothing; a heavily built-in one saves as its edit list.
   */
  serializeEdits() {
    if (this.edits.size === 0) return null;
    const keys = new Uint32Array(this.edits.size);
    const values = new Uint16Array(this.edits.size);
    let i = 0;
    for (const [key, value] of this.edits) {
      keys[i] = key;
      values[i] = value;
      i++;
    }
    return { cx: this.cx, cz: this.cz, keys, values };
  }

  /** Record an edit so it survives a save/load round trip. */
  recordEdit(x, y, z, id) {
    const key = (y << 8) | (z << 4) | x;
    this.edits.set(key, id);
  }

  /** Re-apply saved edits on top of freshly generated terrain. */
  applyEdits(keys, values) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const x = key & 15;
      const z = (key >> 4) & 15;
      const y = key >> 8;
      this.setBlockRaw(x, y, z, values[i]);
      this.edits.set(key, values[i]);
    }
  }

  dispose() {
    for (const mesh of this.meshes.values()) {
      mesh.geometry?.dispose();
    }
    this.meshes.clear();
  }
}
