/**
 * Chunk lighting.
 *
 * Two independent channels, both stored as 4-bit values in the section's light
 * array:
 *
 *   skylight    seeded from the open sky and flooded down and sideways
 *   blocklight  flooded outward from emissive blocks like torches and lava
 *
 * The mesher averages these across the four cells touching each vertex, which
 * is what turns discrete light levels into the smooth gradients that make
 * caves and overhangs read properly.
 */

import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  SECTION_COUNT,
  SECTION_HEIGHT,
  SECTION_VOLUME,
  MAX_LIGHT,
  sectionIndex,
} from './constants.js';
import { AIR } from './blocks.js';

/** Pack local coordinates into a queue entry: x (4) | z (4) | y (8). */
function pack(x, y, z) {
  return (y << 8) | (z << 4) | x;
}

/**
 * A growable integer queue. Reused across chunks so lighting does not churn
 * the allocator once the world is streaming.
 */
class LightQueue {
  constructor(capacity = 1 << 16) {
    this.data = new Int32Array(capacity);
    this.head = 0;
    this.tail = 0;
  }

  reset() {
    this.head = 0;
    this.tail = 0;
  }

  push(value) {
    if (this.tail === this.data.length) {
      if (this.head > this.data.length / 2) {
        // Compact rather than grow when the front has drained.
        this.data.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      } else {
        const next = new Int32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
      }
    }
    this.data[this.tail++] = value;
  }

  pop() {
    return this.data[this.head++];
  }

  get isEmpty() {
    return this.head === this.tail;
  }
}

const queue = new LightQueue();

/**
 * Copy of the chunk's light before a relight, used to work out which sections
 * actually changed. One shared buffer: relighting is never re-entrant.
 */
const snapshot = new Uint8Array(SECTION_COUNT * SECTION_VOLUME);

/**
 * Compute both light channels for a chunk in isolation.
 *
 * @param {import('./chunk.js').Chunk} chunk
 * @param {object} tables  flat block property tables
 * @param {Uint8Array} [changed]  length SECTION_COUNT; set to 1 for every
 *   section whose light differs from before. Passing this turns an edit from
 *   "re-mesh the whole column" into "re-mesh what the light actually reached",
 *   which is the difference between a stutter and a free block placement.
 */
export function computeChunkLight(chunk, tables, changed = null) {
  if (changed) {
    changed.fill(0);
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const section = chunk.sections[sy];
      const base = sy * SECTION_VOLUME;
      if (section) snapshot.set(section.light, base);
      else snapshot.fill(0, base, base + SECTION_VOLUME);
    }
  }

  chunk.updateSkySection();
  clearLight(chunk);
  const ceiling = computeSkyLight(chunk, tables);
  computeBlockLight(chunk, tables, ceiling);

  if (changed) {
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const section = chunk.sections[sy];
      if (!section) continue;
      const base = sy * SECTION_VOLUME;
      for (let i = 0; i < SECTION_VOLUME; i++) {
        if (section.light[i] !== snapshot[base + i]) {
          changed[sy] = 1;
          break;
        }
      }
    }
  }
}

function clearLight(chunk) {
  for (const section of chunk.sections) {
    if (section) section.light.fill(0);
  }
}

/**
 * Skylight. First a vertical pass per column, then a horizontal flood so light
 * reaches under overhangs and into cave mouths.
 *
 * Returns the highest terrain point in the chunk, so the block-light pass can
 * skip the empty sky above it.
 */
function computeSkyLight(chunk, tables) {
  queue.reset();
  let ceiling = 0;

  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      let level = MAX_LIGHT;
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        const id = chunk.getBlock(x, y, z);
        if (id !== AIR) {
          const filter = tables.lightFilter[id];
          level = filter >= MAX_LIGHT ? 0 : Math.max(0, level - Math.max(1, filter));
          if (y > ceiling) ceiling = y;
        }
        if (level === 0) {
          // Everything below an opaque block starts dark; the flood fills it in.
          break;
        }
        // Open sky above the terrain already reads as full daylight from an
        // unallocated section, so writing it would allocate 12 KB per section
        // to store a value the getter already returns.
        if (level === MAX_LIGHT && chunk.isImplicitSky(y)) continue;
        chunk.setSkyLight(x, y, z, level);
      }
    }
  }

  // Seed the flood from any lit cell that borders a darker one. Checking first
  // keeps the queue to the lit/unlit boundary rather than every sky cell.
  const top = Math.min(WORLD_HEIGHT - 1, ceiling + 1);
  for (let y = 0; y <= top; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const level = chunk.getSkyLight(x, y, z);
        if (level <= 1) continue;
        if (bordersDarker(chunk, x, y, z, level, tables, true)) {
          queue.push(pack(x, y, z));
        }
      }
    }
  }

  floodFill(chunk, tables, true);
  return ceiling;
}

/** Blocklight, flooded outward from every emissive block. */
function computeBlockLight(chunk, tables, ceiling) {
  queue.reset();
  const top = Math.min(WORLD_HEIGHT - 1, ceiling + 16);

  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    const section = chunk.sections[sy];
    if (!section || section.isEmpty()) continue;
    if (sy * SECTION_HEIGHT > top) continue;

    for (let y = 0; y < SECTION_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const id = section.blocks[sectionIndex(x, y, z)];
          if (id === AIR) continue;
          const emission = tables.lightLevel[id];
          if (emission === 0) continue;
          const worldY = sy * SECTION_HEIGHT + y;
          chunk.setBlockLight(x, worldY, z, emission);
          queue.push(pack(x, worldY, z));
        }
      }
    }
  }

  floodFill(chunk, tables, false);
}

function bordersDarker(chunk, x, y, z, level, tables, isSky) {
  for (let d = 0; d < 6; d++) {
    const nx = x + NEIGHBORS[d][0];
    const ny = y + NEIGHBORS[d][1];
    const nz = z + NEIGHBORS[d][2];
    if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) continue;
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    if (tables.opaque[chunk.getBlock(nx, ny, nz)]) continue;
    const neighbor = isSky
      ? chunk.getSkyLight(nx, ny, nz)
      : chunk.getBlockLight(nx, ny, nz);
    if (neighbor < level - 1) return true;
  }
  return false;
}

const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** Breadth-first light propagation over the queue's current contents. */
function floodFill(chunk, tables, isSky) {
  while (!queue.isEmpty) {
    const packed = queue.pop();
    const x = packed & 15;
    const z = (packed >> 4) & 15;
    const y = packed >> 8;

    const level = isSky ? chunk.getSkyLight(x, y, z) : chunk.getBlockLight(x, y, z);
    if (level <= 1) continue;

    for (let d = 0; d < 6; d++) {
      const nx = x + NEIGHBORS[d][0];
      const ny = y + NEIGHBORS[d][1];
      const nz = z + NEIGHBORS[d][2];
      if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) continue;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;

      const id = chunk.getBlock(nx, ny, nz);
      const filter = id === AIR ? 0 : tables.lightFilter[id];
      if (filter >= MAX_LIGHT) continue;

      // Skylight travels straight down without attenuating, so a shaft of
      // daylight reaches the bottom of a hole at full strength.
      const cost = isSky && d === 3 && filter === 0 ? 0 : Math.max(1, filter);
      const next = level - cost;
      if (next <= 0) continue;

      const current = isSky ? chunk.getSkyLight(nx, ny, nz) : chunk.getBlockLight(nx, ny, nz);
      if (current >= next) continue;

      if (isSky) chunk.setSkyLight(nx, ny, nz, next);
      else chunk.setBlockLight(nx, ny, nz, next);
      queue.push(pack(nx, ny, nz));
    }
  }
}
