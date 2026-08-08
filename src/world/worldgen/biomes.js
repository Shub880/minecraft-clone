/**
 * Biome table and selection.
 *
 * Biomes are chosen from a temperature x humidity grid (a Whittaker diagram),
 * with elevation and continentalness overriding it for oceans, beaches, rivers
 * and alpine peaks. Tint colours here are *multipliers* applied to greyscale
 * grass and foliage textures, which is what lets one texture serve every biome.
 */

import * as B from '../blocks.js';

export const BiomeId = {
  DEEP_OCEAN: 0,
  OCEAN: 1,
  BEACH: 2,
  RIVER: 3,
  PLAINS: 4,
  FOREST: 5,
  DENSE_FOREST: 6,
  TAIGA: 7,
  SNOWY_TUNDRA: 8,
  DESERT: 9,
  SAVANNA: 10,
  MESA: 11,
  SWAMP: 12,
  ALPINE: 13,
  CHERRY_GROVE: 14,
  VOLCANIC: 15,
};

/** Tree archetypes, resolved into actual blocks by the feature placer. */
export const TreeType = {
  NONE: 0,
  OAK: 1,
  BIRCH: 2,
  SPRUCE: 3,
  LARGE_SPRUCE: 4,
  CHERRY: 5,
  DARK_OAK: 6,
  ACACIA: 7,
  CACTUS: 8,
  DEAD: 9,
  SWAMP_OAK: 10,
};

const biomes = [];

function define(id, name, options) {
  biomes[id] = {
    id,
    name,
    display: options.display ?? name,
    surface: options.surface ?? B.GRASS_BLOCK,
    subsurface: options.subsurface ?? B.DIRT,
    underwater: options.underwater ?? B.GRAVEL,
    filler: options.filler ?? B.STONE,
    grass: options.grass ?? [140, 200, 96],
    foliage: options.foliage ?? [120, 190, 88],
    water: options.water ?? [255, 255, 255],
    tree: options.tree ?? TreeType.NONE,
    treeDensity: options.treeDensity ?? 0,
    secondaryTree: options.secondaryTree ?? TreeType.NONE,
    secondaryChance: options.secondaryChance ?? 0,
    plants: options.plants ?? [],
    snow: options.snow ?? false,
    // Surface layer thickness in blocks.
    surfaceDepth: options.surfaceDepth ?? 1,
    subsurfaceDepth: options.subsurfaceDepth ?? 3,
  };
  return biomes[id];
}

const GRASS_PLANTS = [
  { id: B.GRASS_BLADE, density: 0.22 },
  { id: B.FLOWER_POPPY, density: 0.008 },
  { id: B.FLOWER_DANDELION, density: 0.01 },
  { id: B.FLOWER_CORNFLOWER, density: 0.006 },
];

define(BiomeId.DEEP_OCEAN, 'deep_ocean', {
  display: 'Deep Ocean',
  surface: B.GRAVEL, subsurface: B.GRAVEL, underwater: B.GRAVEL,
  water: [190, 210, 255],
});
define(BiomeId.OCEAN, 'ocean', {
  display: 'Ocean',
  surface: B.SAND, subsurface: B.SAND, underwater: B.SAND,
  water: [225, 240, 255],
});
define(BiomeId.BEACH, 'beach', {
  display: 'Beach',
  surface: B.SAND, subsurface: B.SAND, underwater: B.SAND,
  subsurfaceDepth: 4,
  water: [235, 248, 255],
});
define(BiomeId.RIVER, 'river', {
  display: 'River',
  surface: B.SAND, subsurface: B.CLAY, underwater: B.SAND,
  water: [225, 245, 255],
});

define(BiomeId.PLAINS, 'plains', {
  display: 'Plains',
  grass: [142, 202, 96], foliage: [122, 190, 88],
  tree: TreeType.OAK, treeDensity: 0.004,
  plants: GRASS_PLANTS,
});
define(BiomeId.FOREST, 'forest', {
  display: 'Forest',
  grass: [112, 186, 88], foliage: [96, 176, 80],
  tree: TreeType.OAK, treeDensity: 0.055,
  secondaryTree: TreeType.BIRCH, secondaryChance: 0.35,
  plants: [{ id: B.GRASS_BLADE, density: 0.18 }, { id: B.FERN, density: 0.05 },
    { id: B.FLOWER_POPPY, density: 0.006 }],
});
define(BiomeId.DENSE_FOREST, 'dense_forest', {
  display: 'Dark Forest',
  grass: [92, 160, 70], foliage: [76, 150, 62],
  surface: B.GRASS_BLOCK, subsurface: B.DIRT,
  tree: TreeType.DARK_OAK, treeDensity: 0.085,
  plants: [{ id: B.GRASS_BLADE, density: 0.12 }, { id: B.FERN, density: 0.08 }],
});
define(BiomeId.TAIGA, 'taiga', {
  display: 'Taiga',
  grass: [110, 168, 130], foliage: [94, 158, 120],
  surface: B.GRASS_BLOCK, subsurface: B.PODZOL,
  tree: TreeType.SPRUCE, treeDensity: 0.06,
  secondaryTree: TreeType.LARGE_SPRUCE, secondaryChance: 0.2,
  plants: [{ id: B.FERN, density: 0.14 }, { id: B.GRASS_BLADE, density: 0.06 }],
});
define(BiomeId.SNOWY_TUNDRA, 'snowy_tundra', {
  display: 'Snowy Tundra',
  grass: [152, 192, 182], foliage: [142, 182, 176],
  surface: B.SNOW_BLOCK, subsurface: B.DIRT,
  tree: TreeType.SPRUCE, treeDensity: 0.008,
  snow: true,
  water: [200, 230, 255],
});
define(BiomeId.DESERT, 'desert', {
  display: 'Desert',
  grass: [204, 192, 112], foliage: [194, 182, 106],
  surface: B.SAND, subsurface: B.SANDSTONE,
  subsurfaceDepth: 5,
  tree: TreeType.CACTUS, treeDensity: 0.012,
  plants: [{ id: B.DEAD_BUSH, density: 0.01 }],
});
define(BiomeId.SAVANNA, 'savanna', {
  display: 'Savanna',
  grass: [198, 190, 100], foliage: [182, 176, 94],
  tree: TreeType.ACACIA, treeDensity: 0.012,
  plants: [{ id: B.GRASS_BLADE, density: 0.26 }, { id: B.FLOWER_DANDELION, density: 0.004 }],
});
define(BiomeId.MESA, 'mesa', {
  display: 'Badlands',
  grass: [188, 168, 110], foliage: [178, 158, 104],
  surface: B.RED_TERRACOTTA, subsurface: B.TERRACOTTA,
  subsurfaceDepth: 6,
  plants: [{ id: B.DEAD_BUSH, density: 0.014 }],
});
define(BiomeId.SWAMP, 'swamp', {
  display: 'Swamp',
  grass: [108, 150, 88], foliage: [98, 142, 84],
  surface: B.GRASS_BLOCK, subsurface: B.MUD,
  water: [128, 168, 120],
  tree: TreeType.SWAMP_OAK, treeDensity: 0.03,
  plants: [{ id: B.GRASS_BLADE, density: 0.2 }, { id: B.SUGAR_CANE, density: 0.02 }],
});
define(BiomeId.ALPINE, 'alpine', {
  display: 'Alpine Peaks',
  grass: [130, 176, 122], foliage: [118, 166, 114],
  surface: B.STONE, subsurface: B.STONE,
  snow: true,
  tree: TreeType.SPRUCE, treeDensity: 0.004,
});
define(BiomeId.CHERRY_GROVE, 'cherry_grove', {
  display: 'Cherry Grove',
  grass: [158, 208, 122], foliage: [255, 255, 255],
  tree: TreeType.CHERRY, treeDensity: 0.05,
  plants: [{ id: B.GRASS_BLADE, density: 0.2 }, { id: B.FLOWER_POPPY, density: 0.012 }],
});
define(BiomeId.VOLCANIC, 'volcanic', {
  display: 'Volcanic Wastes',
  grass: [140, 130, 120], foliage: [130, 120, 112],
  surface: B.BASALT, subsurface: B.BASALT, filler: B.BASALT,
  subsurfaceDepth: 5,
  plants: [{ id: B.DEAD_BUSH, density: 0.006 }],
});

export const BIOMES = biomes;

export function getBiome(id) {
  return biomes[id] ?? biomes[BiomeId.PLAINS];
}

/** Flat lookup tables handed to workers. */
export function buildBiomeTables() {
  const count = biomes.length;
  const tables = {
    surface: new Uint16Array(count),
    subsurface: new Uint16Array(count),
    underwater: new Uint16Array(count),
    filler: new Uint16Array(count),
    surfaceDepth: new Uint8Array(count),
    subsurfaceDepth: new Uint8Array(count),
    snow: new Uint8Array(count),
    // Grass, foliage and water tint, RGB each, matching the mesher's stride.
    tint: new Uint8Array(count * 9),
  };
  for (let i = 0; i < count; i++) {
    const biome = biomes[i];
    tables.surface[i] = biome.surface;
    tables.subsurface[i] = biome.subsurface;
    tables.underwater[i] = biome.underwater;
    tables.filler[i] = biome.filler;
    tables.surfaceDepth[i] = biome.surfaceDepth;
    tables.subsurfaceDepth[i] = biome.subsurfaceDepth;
    tables.snow[i] = biome.snow ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      tables.tint[i * 9 + k] = biome.grass[k];
      tables.tint[i * 9 + 3 + k] = biome.foliage[k];
      tables.tint[i * 9 + 6 + k] = biome.water[k];
    }
  }
  return tables;
}

/**
 * Pick a biome from the climate fields.
 *
 * Ocean and river depend on shape rather than climate, so they are resolved
 * first; everything else falls out of the temperature/humidity grid, with a
 * final elevation override so any warm biome still turns alpine at altitude.
 *
 * @param {number} temperature -1 (cold) .. 1 (hot)
 * @param {number} humidity    -1 (dry) .. 1 (wet)
 * @param {number} height      terrain height in blocks
 * @param {number} continent   -1 (deep ocean) .. 1 (inland)
 * @param {number} river       0 .. 1, 1 on a river centreline
 * @param {number} seaLevel
 */
export function selectBiome(temperature, humidity, height, continent, river, seaLevel) {
  if (height < seaLevel - 14) return BiomeId.DEEP_OCEAN;
  if (height < seaLevel - 1) return BiomeId.OCEAN;

  if (river > 0.5 && height <= seaLevel + 2) return BiomeId.RIVER;

  // Sand fringe wherever land meets the sea.
  if (height <= seaLevel + 2 && continent < 0.35) return BiomeId.BEACH;

  // Altitude wins over climate: a hot mountain is still bare rock and snow.
  if (height > 132) return BiomeId.ALPINE;

  if (temperature > 0.62 && humidity < -0.42) {
    return height > 96 ? BiomeId.MESA : BiomeId.DESERT;
  }
  if (temperature > 0.78 && humidity < -0.62) return BiomeId.VOLCANIC;

  if (temperature > 0.3) {
    if (humidity < -0.1) return BiomeId.SAVANNA;
    if (humidity > 0.55) return BiomeId.DENSE_FOREST;
    return BiomeId.FOREST;
  }

  if (temperature < -0.45) {
    return humidity > -0.1 ? BiomeId.TAIGA : BiomeId.SNOWY_TUNDRA;
  }

  if (temperature < -0.1) {
    return humidity > 0.2 ? BiomeId.TAIGA : BiomeId.PLAINS;
  }

  // Temperate band.
  if (humidity > 0.62 && height < seaLevel + 6) return BiomeId.SWAMP;
  if (humidity > 0.34) return BiomeId.FOREST;
  if (humidity > 0.12 && temperature > 0.05) return BiomeId.CHERRY_GROVE;
  return BiomeId.PLAINS;
}
