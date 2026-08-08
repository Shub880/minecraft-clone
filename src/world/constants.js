/**
 * World dimensions, shared by the main thread and every worker.
 *
 * Kept in its own module with no dependencies so workers can import it without
 * dragging in Three.js or DOM code.
 */

/** Horizontal size of a chunk column, in blocks. */
export const CHUNK_SIZE = 16;

/** Vertical size of a section, in blocks. Sections are cubes. */
export const SECTION_HEIGHT = 16;

/** Number of stacked sections per chunk column. */
export const SECTION_COUNT = 16;

/** Total world height in blocks. */
export const WORLD_HEIGHT = SECTION_HEIGHT * SECTION_COUNT;

/** Blocks per section. */
export const SECTION_VOLUME = CHUNK_SIZE * CHUNK_SIZE * SECTION_HEIGHT;

/** Blocks per chunk column. */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

/** Sea level. Terrain shaping and biome selection both key off this. */
export const SEA_LEVEL = 62;

/** Padded section volume used by the mesher: 16 interior + 1 border each side. */
export const PADDED_SIZE = SECTION_HEIGHT + 2;
export const PADDED_VOLUME = PADDED_SIZE * PADDED_SIZE * PADDED_SIZE;

/** Maximum light level. */
export const MAX_LIGHT = 15;

/**
 * Bytes of tint stored per column: grass RGB, foliage RGB, water RGB.
 * Chunk storage and the mesher both index with this stride, so it lives here
 * rather than in either of them.
 */
export const TINT_STRIDE = 9;

/** Index a block inside a section from local coordinates (all 0..15). */
export function sectionIndex(x, y, z) {
  return (y << 8) | (z << 4) | x;
}

/**
 * Index into a padded 18^3 volume. Accepts interior coordinates in -1..16, so
 * the mesher can read one block past a section boundary without bounds checks.
 */
export function paddedIndex(x, y, z) {
  return ((y + 1) * PADDED_SIZE + (z + 1)) * PADDED_SIZE + (x + 1);
}

/** Pack chunk coordinates into a single map key. */
export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

/** Floor-divide a world coordinate to its chunk coordinate. */
export function toChunkCoord(worldCoord) {
  return Math.floor(worldCoord / CHUNK_SIZE);
}

/** World coordinate to local in-chunk coordinate, always 0..15. */
export function toLocalCoord(worldCoord) {
  return ((worldCoord % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}
