/**
 * Structure generation.
 *
 * Trees are small enough that generating every tree in the 3x3 chunks around
 * the one being built is cheap. A village is not: it can be eighty blocks
 * across, so the same trick would mean visiting a 7x7 neighbourhood of chunks
 * for every chunk in the world.
 *
 * Instead the world is cut into a coarse grid of *cells* — one cell is
 * `spacing` chunks square, per structure kind — and each cell decides, from a
 * hash of its own coordinates, whether it holds a structure and where inside
 * itself it sits. Generating a chunk then only means asking the handful of
 * cells whose structures could possibly reach it. Nothing depends on
 * generation order, and both halves of a structure that straddles a chunk
 * border agree exactly because both halves are computed from the same cell.
 *
 * Every builder writes through a `place` callback that silently drops anything
 * outside the chunk currently being generated, so a builder is written as
 * though it had the whole world to draw on and never has to think about
 * borders.
 */

import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from '../constants.js';
import { rngAt2 } from '../../core/rng.js';
import { BiomeId } from './biomes.js';
import * as B from '../blocks.js';

/**
 * Structure kinds.
 *
 * `spacing`   cell size in chunks; larger means rarer and further apart
 * `chance`    probability a given cell holds one at all
 * `radius`    horizontal half-extent in blocks, used to decide which chunks a
 *             structure can reach. Must be a genuine bound or a structure will
 *             be clipped at a chunk border it was allowed to cross.
 * `biomes`    the biome ids it may generate in, or null for anywhere
 * `flatness`  largest height spread tolerated across the footprint, in blocks
 * `build`     draws it, through the clipped placer
 */
const STRUCTURES = [
  {
    name: 'village',
    salt: 501,
    spacing: 26,
    chance: 0.62,
    radius: 46,
    flatness: 6,
    biomes: [BiomeId.PLAINS, BiomeId.SAVANNA, BiomeId.FOREST, BiomeId.TAIGA, BiomeId.SNOWY_TUNDRA],
    build: buildVillage,
  },
  {
    name: 'desert_temple',
    salt: 502,
    spacing: 22,
    chance: 0.5,
    radius: 12,
    flatness: 5,
    biomes: [BiomeId.DESERT],
    build: buildDesertTemple,
  },
  {
    name: 'igloo',
    salt: 503,
    spacing: 16,
    chance: 0.45,
    radius: 8,
    flatness: 4,
    biomes: [BiomeId.SNOWY_TUNDRA],
    build: buildIgloo,
  },
  {
    name: 'swamp_hut',
    salt: 504,
    spacing: 18,
    chance: 0.5,
    radius: 9,
    flatness: 20,
    biomes: [BiomeId.SWAMP],
    build: buildSwampHut,
  },
  {
    name: 'ruined_tower',
    salt: 505,
    spacing: 14,
    chance: 0.55,
    radius: 9,
    flatness: 5,
    biomes: [BiomeId.PLAINS, BiomeId.FOREST, BiomeId.DENSE_FOREST, BiomeId.SAVANNA, BiomeId.TAIGA],
    build: buildRuinedTower,
  },
  {
    name: 'boulder',
    salt: 506,
    spacing: 5,
    chance: 0.5,
    radius: 6,
    flatness: 7,
    biomes: [BiomeId.FOREST, BiomeId.DENSE_FOREST, BiomeId.TAIGA, BiomeId.ALPINE, BiomeId.PLAINS],
    build: buildBoulder,
  },
  {
    name: 'fallen_log',
    salt: 507,
    spacing: 6,
    chance: 0.45,
    radius: 7,
    flatness: 3,
    biomes: [BiomeId.FOREST, BiomeId.DENSE_FOREST, BiomeId.TAIGA],
    build: buildFallenLog,
  },
  {
    name: 'dungeon',
    salt: 508,
    spacing: 7,
    chance: 0.55,
    radius: 6,
    // Dungeons are buried, so the surface above them can be any shape at all.
    flatness: Infinity,
    biomes: null,
    underground: true,
    build: buildDungeon,
  },
];

/**
 * Place every structure that reaches into one chunk.
 *
 * @param {import('./terrain.js').TerrainGenerator} generator
 * @param {import('../chunk.js').Chunk} chunk
 * @param {(wx:number, wy:number, wz:number, id:number, onlyAir?:boolean) => void} place
 */
export function placeStructures(generator, chunk, place) {
  if (generator.structureDensity <= 0) return;

  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;

  for (const structure of STRUCTURES) {
    // How many cells away a structure of this size could still reach us.
    const cellBlocks = structure.spacing * CHUNK_SIZE;
    const reach = Math.ceil((structure.radius + CHUNK_SIZE) / cellBlocks);
    const baseCellX = Math.floor(originX / cellBlocks);
    const baseCellZ = Math.floor(originZ / cellBlocks);

    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const site = siteIn(generator, structure, baseCellX + dx, baseCellZ + dz);
        if (!site) continue;
        // Bounding-box reject before the builder runs. Most candidate sites
        // never touch this chunk, and rejecting them here is the difference
        // between checking eight structures and drawing eight of them.
        if (site.x + structure.radius < originX || site.x - structure.radius >= originX + CHUNK_SIZE) continue;
        if (site.z + structure.radius < originZ || site.z - structure.radius >= originZ + CHUNK_SIZE) continue;
        structure.build(makeContext(generator, structure, site, place));
      }
    }
  }
}

/**
 * Decide whether one cell holds a structure, and where.
 *
 * Returns null when the cell is empty or the ground there is unsuitable. Pure
 * in (cell, seed), so every chunk that asks gets the same answer.
 */
function siteIn(generator, structure, cellX, cellZ) {
  const rand = rngAt2(cellX, cellZ, generator.seed, structure.salt);
  if (rand() >= structure.chance * generator.structureDensity) return null;

  const cellBlocks = structure.spacing * CHUNK_SIZE;
  // Keep the origin away from the cell edge so neighbouring cells' structures
  // cannot end up on top of each other.
  const margin = Math.min(structure.radius + 4, cellBlocks / 2 - 1);
  const span = cellBlocks - margin * 2;
  const x = Math.floor(cellX * cellBlocks + margin + rand() * span);
  const z = Math.floor(cellZ * cellBlocks + margin + rand() * span);

  const surface = generator.heightAt(x, z);
  const biome = generator.biomeAt(x, z, surface);

  if (structure.underground) {
    // Buried structures need enough rock above them to stay hidden and enough
    // below to sit on.
    if (surface < SEA_LEVEL + 2) return null;
    const y = 8 + Math.floor(rand() * Math.max(1, Math.min(40, surface - 22)));
    return { x, y, z, surface, biome, rand };
  }

  if (surface <= SEA_LEVEL + (structure.name === 'swamp_hut' ? -1 : 1)) return null;
  if (structure.biomes && !structure.biomes.includes(biome)) return null;

  // Reject slopes. A building half-buried in a hillside is worse than no
  // building, and this is far cheaper than terraforming the hill.
  if (Number.isFinite(structure.flatness)) {
    const probe = Math.max(3, Math.min(16, structure.radius));
    const corners = [
      generator.heightAt(x + probe, z), generator.heightAt(x - probe, z),
      generator.heightAt(x, z + probe), generator.heightAt(x, z - probe),
    ];
    const spread = Math.max(surface, ...corners) - Math.min(surface, ...corners);
    if (spread > structure.flatness) return null;
  }

  return { x, y: surface, z, surface, biome, rand };
}

/** Everything a builder is handed. */
function makeContext(generator, structure, site, place) {
  return {
    generator,
    place,
    // A second stream, so adding a rejection test above cannot change the
    // shape of an already-generated structure.
    rand: rngAt2(site.x, site.z, generator.seed, structure.salt + 9001),
    x: site.x,
    y: site.y,
    z: site.z,
    biome: site.biome,
    groundAt: (wx, wz) => generator.heightAt(wx, wz),
  };
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** Solid axis-aligned box, inclusive of both corners. */
function box(place, x0, y0, z0, x1, y1, z1, id, onlyAir = false) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) place(x, y, z, id, onlyAir);
    }
  }
}

/** Just the walls of a box: the four vertical sides, no floor or ceiling. */
function walls(place, x0, y0, z0, x1, y1, z1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      place(x, y, z0, id, false);
      place(x, y, z1, id, false);
    }
    for (let z = z0 + 1; z < z1; z++) {
      place(x0, y, z, id, false);
      place(x1, y, z, id, false);
    }
  }
}

/** Clear a volume and drop a foundation under it so nothing floats. */
function clearAndFound(place, groundAt, x0, z0, x1, z1, floorY, height, floorId) {
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      for (let y = floorY; y <= floorY + height; y++) place(x, y, z, B.AIR, false);
      place(x, floorY - 1, z, floorId, false);
      // Fill down to the terrain so a building on a slight rise is not
      // standing on a plinth of air.
      const ground = groundAt(x, z);
      for (let y = floorY - 2; y >= Math.min(ground - 1, floorY - 2); y--) {
        place(x, y, z, floorId, true);
      }
    }
  }
}

/** Two sloping roof planes meeting at a ridge running along X. */
function gableRoof(place, x0, z0, x1, z1, baseY, id) {
  const depth = z1 - z0;
  const steps = Math.floor(depth / 2) + 1;
  for (let step = 0; step < steps; step++) {
    const y = baseY + step;
    const near = z0 + step;
    const far = z1 - step;
    if (near > far) break;
    for (let x = x0; x <= x1; x++) {
      place(x, y, near, id, false);
      place(x, y, far, id, false);
      // Cap the ridge, and close the gable ends underneath the slope.
      if (near === far || near + 1 === far) {
        for (let z = near; z <= far; z++) place(x, y, z, id, false);
      } else if (x === x0 || x === x1) {
        for (let z = near + 1; z < far; z++) place(x, y, z, id, false);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Villages
// ---------------------------------------------------------------------------

/** Materials a village is built from, chosen by the biome it sits in. */
const VILLAGE_STYLES = {
  [BiomeId.PLAINS]: { wall: B.OAK_PLANKS, beam: B.OAK_LOG, roof: B.OAK_PLANKS, path: B.COARSE_DIRT, base: B.COBBLESTONE },
  [BiomeId.SAVANNA]: { wall: B.OAK_PLANKS, beam: B.OAK_LOG, roof: B.HAY_BLOCK, path: B.COARSE_DIRT, base: B.COBBLESTONE },
  [BiomeId.FOREST]: { wall: B.OAK_PLANKS, beam: B.OAK_LOG, roof: B.OAK_PLANKS, path: B.GRAVEL, base: B.COBBLESTONE },
  [BiomeId.TAIGA]: { wall: B.SPRUCE_PLANKS, beam: B.SPRUCE_LOG, roof: B.SPRUCE_PLANKS, path: B.GRAVEL, base: B.COBBLESTONE },
  [BiomeId.SNOWY_TUNDRA]: { wall: B.SPRUCE_PLANKS, beam: B.SPRUCE_LOG, roof: B.SPRUCE_PLANKS, path: B.GRAVEL, base: B.COBBLESTONE },
};

const BED_COLOURS = [B.RED_WOOL, B.BLUE_WOOL, B.GREEN_WOOL, B.YELLOW_WOOL, B.ORANGE_WOOL];

/**
 * A cluster of small buildings around a well, joined by paths.
 *
 * Plot positions are drawn from the structure's own RNG stream before anything
 * is drawn, so the layout is identical no matter which chunk asks for it — the
 * builder runs once per chunk the village touches and must agree with itself
 * every time.
 */
function buildVillage(ctx) {
  const { place, rand, x, z, groundAt } = ctx;
  const style = VILLAGE_STYLES[ctx.biome] ?? VILLAGE_STYLES[BiomeId.PLAINS];
  const centreY = ctx.y;

  buildWell(place, x, centreY, z, style);

  const count = 4 + Math.floor(rand() * 4);
  const plots = [];
  for (let i = 0; i < count; i++) {
    // Ring layout: an angle per building plus jitter, which reads as a village
    // green far better than a grid does.
    const angle = (i / count) * Math.PI * 2 + rand() * 0.7;
    const distance = 12 + rand() * 22;
    plots.push({
      x: x + Math.round(Math.cos(angle) * distance),
      z: z + Math.round(Math.sin(angle) * distance),
      kind: rand(),
      seed: rand(),
    });
  }

  for (const plot of plots) {
    path(place, groundAt, x, z, plot.x, plot.z, style.path);
  }

  for (const plot of plots) {
    const ground = groundAt(plot.x, plot.z);
    // A plot that landed in a pond or on a cliff is simply skipped; the rest
    // of the village still generates around the gap.
    if (ground <= SEA_LEVEL) continue;
    if (Math.abs(ground - centreY) > 7) continue;
    if (plot.kind < 0.24) buildFarm(place, groundAt, plot.x, ground, plot.z, plot.seed);
    else buildHouse(place, groundAt, plot.x, ground, plot.z, style, plot.seed);
  }

  // Lamp posts along the green, so a village is findable after dark.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + 0.4;
    const lx = x + Math.round(Math.cos(angle) * 7);
    const lz = z + Math.round(Math.sin(angle) * 7);
    const ground = groundAt(lx, lz);
    if (ground <= SEA_LEVEL) continue;
    for (let h = 1; h <= 3; h++) place(lx, ground + h, lz, style.beam, false);
    place(lx, ground + 4, lz, B.GLOWSTONE, false);
  }
}

/** The village well: a cobble ring around a two-block column of water. */
function buildWell(place, x, y, z, style) {
  box(place, x - 2, y, z - 2, x + 2, y + 3, z + 2, B.AIR, false);
  box(place, x - 2, y - 1, z - 2, x + 2, y - 1, z + 2, style.base, false);
  walls(place, x - 2, y, z - 2, x + 2, y + 1, z + 2, style.base);
  box(place, x - 1, y - 3, z - 1, x + 1, y, z + 1, B.WATER, false);
  // Four corner posts carrying a flat roof.
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    for (let h = 2; h <= 4; h++) place(x + dx, y + h, z + dz, style.beam, false);
  }
  box(place, x - 2, y + 5, z - 2, x + 2, y + 5, z + 2, style.roof, false);
}

/** A one-room cottage with a door gap, windows, a bed and a workbench. */
function buildHouse(place, groundAt, x, y, z, style, seed) {
  const rand = seededStream(seed);
  const halfX = 2 + Math.floor(rand() * 2);
  const halfZ = 2 + Math.floor(rand() * 2);
  const wallHeight = 3;

  const x0 = x - halfX;
  const x1 = x + halfX;
  const z0 = z - halfZ;
  const z1 = z + halfZ;

  clearAndFound(place, groundAt, x0, z0, x1, z1, y + 1, wallHeight + halfZ + 2, style.base);

  // Stone footing, timber walls, corner posts.
  box(place, x0, y, z0, x1, y, z1, style.base, false);
  walls(place, x0, y + 1, z0, x1, y + wallHeight, z1, style.wall);
  for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
    for (let h = 1; h <= wallHeight; h++) place(cx, y + h, cz, style.beam, false);
  }

  // Doorway in the middle of the south wall.
  place(x, y + 1, z1, B.AIR, false);
  place(x, y + 2, z1, B.AIR, false);
  place(x, y + 1, z1 + 1, style.base, false);

  // Windows: one per side wall, at eye height.
  place(x0, y + 2, z, B.GLASS, false);
  place(x1, y + 2, z, B.GLASS, false);
  place(x, y + 2, z0, B.GLASS, false);

  gableRoof(place, x0 - 1, z0 - 1, x1 + 1, z1 + 1, y + wallHeight + 1, style.roof);

  // Furnishings. A bed reads as two wool blocks; there is no bed block here
  // and inventing one for a decoration would leak into the whole registry.
  const bed = BED_COLOURS[Math.floor(rand() * BED_COLOURS.length)];
  place(x0 + 1, y + 1, z0 + 1, bed, false);
  place(x0 + 1, y + 1, z0 + 2, B.WHITE_WOOL, false);
  place(x1 - 1, y + 1, z0 + 1, rand() < 0.5 ? B.CRAFTING_TABLE : B.FURNACE, false);
  place(x1 - 1, y + 1, z1 - 1, B.CHEST, false);
  if (rand() < 0.5) place(x0 + 1, y + 1, z1 - 1, B.BOOKSHELF, false);
  // Torch on the inside of the back wall.
  place(x, y + 2, z0 + 1, B.TORCH, true);
}

/** A fenced crop plot: tilled rows either side of a water channel. */
function buildFarm(place, groundAt, x, y, z, seed) {
  const rand = seededStream(seed);
  const halfX = 3;
  const halfZ = 2 + Math.floor(rand() * 2);

  clearAndFound(place, groundAt, x - halfX, z - halfZ, x + halfX, z + halfZ, y + 1, 2, B.DIRT);

  for (let dz = -halfZ; dz <= halfZ; dz++) {
    for (let dx = -halfX; dx <= halfX; dx++) {
      const edge = Math.abs(dx) === halfX || Math.abs(dz) === halfZ;
      if (edge) {
        // Log kerb rather than a fence, which would need a new block shape.
        place(x + dx, y, z + dz, B.OAK_LOG, false);
        continue;
      }
      // A water channel down the middle, tilled soil either side.
      if (dz === 0) {
        place(x + dx, y, z + dz, B.WATER, false);
        continue;
      }
      place(x + dx, y, z + dz, B.MUD, false);
      const roll = rand();
      if (roll < 0.28) place(x + dx, y + 1, z + dz, B.HAY_BLOCK, true);
      else if (roll < 0.4) place(x + dx, y + 1, z + dz, roll < 0.34 ? B.PUMPKIN : B.MELON, true);
    }
  }
}

/** A worn track between two points, one block wide, following the terrain. */
function path(place, groundAt, x0, z0, x1, z1, id) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  if (steps === 0) return;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = Math.round(x0 + (x1 - x0) * t);
    const pz = Math.round(z0 + (z1 - z0) * t);
    const ground = groundAt(px, pz);
    if (ground <= SEA_LEVEL) continue;
    place(px, ground, pz, id, false);
    // Widened on the diagonal so a path does not break into disconnected
    // squares wherever it changes row and column at once.
    place(px + 1, groundAt(px + 1, pz) === ground ? ground : ground, pz, id, false);
    place(px, ground + 1, pz, B.AIR, false);
  }
}

// ---------------------------------------------------------------------------
// Desert temple
// ---------------------------------------------------------------------------

/** A stepped sandstone pyramid over a buried treasure chamber. */
function buildDesertTemple(ctx) {
  const { place, rand, x, y, z, groundAt } = ctx;
  const base = 9;

  // Sink the whole thing one block so the bottom course is not on stilts.
  const floorY = y - 1;
  for (let dz = -base; dz <= base; dz++) {
    for (let dx = -base; dx <= base; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) > base) continue;
      const ground = groundAt(x + dx, z + dz);
      for (let fy = Math.min(ground, floorY); fy <= floorY; fy++) {
        place(x + dx, fy, z + dz, B.SANDSTONE, false);
      }
    }
  }

  // Stepped courses, hollow above the second so the inside is a room.
  for (let level = 0; level <= base; level++) {
    const half = base - level;
    const wy = floorY + 1 + level;
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const hollow = level >= 1 && level <= 4 && ring < half - 1;
        if (hollow) {
          place(x + dx, wy, z + dz, B.AIR, false);
          continue;
        }
        // Banded courses, the detail that makes a pyramid read as masonry.
        const id = ring === half && level % 3 === 1 ? B.CHISELED_SANDSTONE : B.SANDSTONE;
        place(x + dx, wy, z + dz, id, false);
      }
    }
  }

  // Entrance on the north face.
  for (let h = 1; h <= 2; h++) {
    for (let dz = base; dz >= base - 2; dz--) place(x, floorY + h, z + dz, B.AIR, false);
  }

  // The buried chamber, reached by a shaft under the middle of the floor.
  const chamberY = floorY - 6;
  box(place, x - 3, chamberY, z - 3, x + 3, chamberY + 3, z + 3, B.AIR, false);
  walls(place, x - 4, chamberY - 1, z - 4, x + 4, chamberY + 4, z + 4, B.SANDSTONE);
  box(place, x - 4, chamberY - 1, z - 4, x + 4, chamberY - 1, z + 4, B.SANDSTONE, false);
  box(place, x - 4, chamberY + 4, z - 4, x + 4, chamberY + 4, z + 4, B.SANDSTONE, false);
  for (let sy = chamberY + 4; sy <= floorY; sy++) place(x, sy, z, B.AIR, false);

  // Blue-and-orange floor motif, and the chests it points at.
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dz));
      const id = ring === 0 ? B.BLUE_WOOL : ring === 1 ? B.ORANGE_WOOL : B.CHISELED_SANDSTONE;
      place(x + dx, chamberY - 1, z + dz, id, false);
    }
  }
  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    if (rand() < 0.75) place(x + dx, chamberY, z + dz, B.CHEST, false);
  }
  place(x - 3, chamberY + 2, z, B.TORCH, true);
  place(x + 3, chamberY + 2, z, B.TORCH, true);
}

// ---------------------------------------------------------------------------
// Small structures
// ---------------------------------------------------------------------------

/** A snow dome with an ice window and a hearth inside. */
function buildIgloo(ctx) {
  const { place, rand, x, y, z } = ctx;
  const radius = 4;

  for (let dy = 0; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > radius + 0.4) continue;
        // Shell only: anything more than one block inside the surface is air.
        const id = d > radius - 1 ? B.SNOW_BLOCK : B.AIR;
        place(x + dx, y + dy, z + dz, id, false);
      }
    }
  }

  box(place, x - radius, y - 1, z - radius, x + radius, y - 1, z + radius, B.SNOW_BLOCK, false);
  // Entrance tunnel out of the south side.
  for (let dz = radius - 1; dz <= radius + 2; dz++) {
    place(x, y, z + dz, B.AIR, false);
    place(x, y + 1, z + dz, B.AIR, false);
    place(x - 1, y + 1, z + dz, B.SNOW_BLOCK, true);
    place(x + 1, y + 1, z + dz, B.SNOW_BLOCK, true);
    place(x, y + 2, z + dz, B.SNOW_BLOCK, true);
    place(x, y - 1, z + dz, B.SNOW_BLOCK, true);
  }

  place(x, y + radius - 1, z - radius + 1, B.ICE, false);
  place(x - 2, y, z - 2, B.RED_WOOL, false);
  place(x - 2, y, z - 1, B.WHITE_WOOL, false);
  place(x + 2, y, z - 2, B.CRAFTING_TABLE, false);
  place(x + 2, y, z + 1, B.CHEST, false);
  if (rand() < 0.6) place(x, y + 1, z - radius + 2, B.TORCH, true);
}

/** A plank hut on spruce stilts, standing over the water. */
function buildSwampHut(ctx) {
  const { place, x, z, groundAt } = ctx;
  // Deliberately above the waterline rather than the ground: the point of a
  // stilt house is that the ground under it is a swamp.
  const floorY = SEA_LEVEL + 4;

  for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    const ground = groundAt(x + dx, z + dz);
    for (let y = Math.min(ground, floorY); y < floorY; y++) {
      place(x + dx, y, z + dz, B.SPRUCE_LOG, false);
    }
  }

  box(place, x - 3, floorY, z - 3, x + 3, floorY, z + 3, B.SPRUCE_PLANKS, false);
  box(place, x - 3, floorY + 1, z - 3, x + 3, floorY + 3, z + 3, B.AIR, false);
  walls(place, x - 3, floorY + 1, z - 3, x + 3, floorY + 3, z + 3, B.SPRUCE_PLANKS);
  box(place, x - 3, floorY + 4, z - 3, x + 3, floorY + 4, z + 3, B.SPRUCE_PLANKS, false);

  place(x, floorY + 1, z + 3, B.AIR, false);
  place(x, floorY + 2, z + 3, B.AIR, false);
  place(x - 3, floorY + 2, z, B.GLASS, false);
  place(x + 3, floorY + 2, z, B.GLASS, false);

  place(x - 2, floorY + 1, z - 2, B.FURNACE, false);
  place(x + 2, floorY + 1, z - 2, B.CRAFTING_TABLE, false);
  place(x + 2, floorY + 1, z + 2, B.CHEST, false);
  place(x - 2, floorY + 1, z + 2, B.COBWEB, true);
  place(x, floorY + 3, z - 2, B.TORCH, true);
}

/** A broken watchtower: cobble and stone brick, taller on one side. */
function buildRuinedTower(ctx) {
  const { place, rand, x, y, z, groundAt } = ctx;
  const radius = 3;
  const height = 6 + Math.floor(rand() * 5);

  clearAndFound(place, groundAt, x - radius, z - radius, x + radius, z + radius, y + 1, height + 2, B.COBBLESTONE);
  box(place, x - radius, y, z - radius, x + radius, y, z + radius, B.COBBLESTONE, false);

  for (let h = 1; h <= height; h++) {
    // The wall crumbles away with height, and unevenly around the ring, which
    // is what makes a ruin read as fallen rather than unfinished.
    const survival = 1 - (h / height) * 0.75;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        if (rand() > survival) continue;
        const roll = rand();
        const id = roll < 0.25 ? B.MOSSY_STONE_BRICKS
          : roll < 0.5 ? B.CRACKED_STONE_BRICKS
            : roll < 0.72 ? B.STONE_BRICKS : B.MOSSY_COBBLESTONE;
        place(x + dx, y + h, z + dz, id, false);
      }
    }
  }

  // Rubble spilled around the base.
  for (let i = 0; i < 22; i++) {
    const dx = Math.floor((rand() - 0.5) * (radius * 3));
    const dz = Math.floor((rand() - 0.5) * (radius * 3));
    const ground = groundAt(x + dx, z + dz);
    place(x + dx, ground + 1, z + dz, rand() < 0.5 ? B.MOSSY_COBBLESTONE : B.COBBLESTONE, true);
  }

  place(x, y + 1, z, B.CHEST, false);
  place(x - 1, y + 2, z - 1, B.TORCH, true);
  for (let i = 0; i < 3; i++) {
    place(x + Math.floor((rand() - 0.5) * 4), y + 2 + Math.floor(rand() * 3), z + Math.floor((rand() - 0.5) * 4), B.COBWEB, true);
  }
}

/** A weathered rock, half sunk into the ground. */
function buildBoulder(ctx) {
  const { place, rand, x, y, z } = ctx;
  const radius = 1.6 + rand() * 2.2;
  const mossy = ctx.biome === BiomeId.FOREST || ctx.biome === BiomeId.DENSE_FOREST
    || ctx.biome === BiomeId.TAIGA;

  const squashY = 0.7 + rand() * 0.5;
  const limit = Math.ceil(radius) + 1;
  for (let dy = -2; dy <= limit; dy++) {
    for (let dz = -limit; dz <= limit; dz++) {
      for (let dx = -limit; dx <= limit; dx++) {
        const stretched = dy / squashY;
        const d = Math.sqrt(dx * dx + stretched * stretched + dz * dz);
        if (d > radius) continue;
        // Chip the outer shell so the silhouette is not a sphere.
        if (d > radius - 0.9 && rand() < 0.3) continue;
        const roll = rand();
        const id = mossy && roll < 0.4 ? B.MOSS_BLOCK
          : mossy && roll < 0.62 ? B.MOSSY_COBBLESTONE
            : roll < 0.82 ? B.STONE : B.COBBLESTONE;
        place(x + dx, y + dy, z + dz, id, false);
      }
    }
  }
}

/** A toppled trunk with a stump and a scatter of moss. */
function buildFallenLog(ctx) {
  const { place, rand, x, y, z, groundAt } = ctx;
  const alongX = rand() < 0.5;
  const length = 4 + Math.floor(rand() * 4);
  const spruce = ctx.biome === BiomeId.TAIGA;
  const log = spruce ? B.SPRUCE_LOG : B.OAK_LOG;

  // The stump it broke off, still rooted.
  place(x, y + 1, z, log, true);
  place(x, y + 2, z, log, true);

  for (let i = 2; i <= length + 1; i++) {
    const lx = x + (alongX ? i : 0);
    const lz = z + (alongX ? 0 : i);
    const ground = groundAt(lx, lz);
    if (ground <= SEA_LEVEL) break;
    place(lx, ground + 1, lz, log, true);
    if (rand() < 0.35) place(lx, ground + 2, lz, B.MOSS_BLOCK, true);
    if (rand() < 0.3) {
      place(lx + (alongX ? 0 : 1), ground + 1, lz + (alongX ? 1 : 0), B.MOSS_BLOCK, true);
    }
    if (rand() < 0.22) {
      place(lx + (alongX ? 0 : -1), ground + 1, lz + (alongX ? -1 : 0), B.FERN, true);
    }
  }
}

/** A buried mossy room with chests, lit only by what you bring. */
function buildDungeon(ctx) {
  const { place, rand, x, y, z } = ctx;
  const halfX = 3 + Math.floor(rand() * 2);
  const halfZ = 3 + Math.floor(rand() * 2);
  const height = 3;

  box(place, x - halfX, y, z - halfZ, x + halfX, y + height, z + halfZ, B.AIR, false);
  walls(place, x - halfX - 1, y - 1, z - halfZ - 1, x + halfX + 1, y + height + 1, z + halfZ + 1, B.COBBLESTONE);
  box(place, x - halfX - 1, y + height + 1, z - halfZ - 1, x + halfX + 1, y + height + 1, z + halfZ + 1, B.COBBLESTONE, false);

  // Mossy floor, patchier toward the middle.
  for (let dz = -halfZ - 1; dz <= halfZ + 1; dz++) {
    for (let dx = -halfX - 1; dx <= halfX + 1; dx++) {
      place(x + dx, y - 1, z + dz, rand() < 0.42 ? B.MOSSY_COBBLESTONE : B.COBBLESTONE, false);
    }
  }

  for (const [dx, dz] of [[-halfX + 1, -halfZ + 1], [halfX - 1, halfZ - 1], [halfX - 1, -halfZ + 1]]) {
    if (rand() < 0.7) place(x + dx, y, z + dz, B.CHEST, false);
  }
  place(x, y, z, B.MOSSY_COBBLESTONE, false);
  place(x, y + 1, z, B.CRAFTING_TABLE, false);

  for (let i = 0; i < 6; i++) {
    const cx = x + Math.floor((rand() - 0.5) * halfX * 2);
    const cz = z + Math.floor((rand() - 0.5) * halfZ * 2);
    place(cx, y + height, cz, B.COBWEB, true);
  }
  // One lit corner, so the room is findable but not floodlit.
  place(x - halfX + 1, y + 2, z, B.TORCH, true);
}

/** A tiny deterministic stream from a single 0..1 value. */
function seededStream(seed) {
  let a = (Math.floor(seed * 0xffffffff) ^ 0x9e3779b9) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Highest point any structure can reach, used to size the meshing pass. */
export const STRUCTURE_MAX_Y = WORLD_HEIGHT - 1;

/** Every structure kind a player can be told to go and look for. */
export const STRUCTURE_NAMES = STRUCTURES.map((structure) => structure.name);

/**
 * Search outward for the nearest structure of a kind, in rings of cells.
 *
 * The same `siteIn` the generator uses decides each candidate, so what this
 * points at is exactly what will be there when the player arrives — including
 * the terrain rejections, which is why it has to walk cells rather than just
 * do the arithmetic on the grid.
 *
 * @returns {{x:number, y:number, z:number, distance:number}|null}
 */
export function findNearestStructure(generator, name, fromX, fromZ, maxRings = 12) {
  const structure = STRUCTURES.find((candidate) => candidate.name === name);
  if (!structure) return null;

  const cellBlocks = structure.spacing * CHUNK_SIZE;
  const centreX = Math.floor(fromX / cellBlocks);
  const centreZ = Math.floor(fromZ / cellBlocks);

  let best = null;
  for (let ring = 0; ring <= maxRings; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the perimeter of each ring is new.
        if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const site = siteIn(generator, structure, centreX + dx, centreZ + dz);
        if (!site) continue;
        const distance = Math.hypot(site.x - fromX, site.z - fromZ);
        if (!best || distance < best.distance) {
          best = { x: site.x, y: site.y, z: site.z, distance };
        }
      }
    }
    // Finish the ring that produced a hit, then stop: a nearer site cannot be
    // hiding two rings further out.
    if (best) return best;
  }
  return null;
}
