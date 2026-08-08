/**
 * Block registry.
 *
 * Every block type in the game is declared here once. The mesher, lighting,
 * physics, interaction and inventory systems all read from the flat lookup
 * tables at the bottom of the file rather than the object form, because those
 * tables are cheap to hand to a worker and cheap to index in hot loops.
 *
 * Face order is fixed everywhere in the codebase:
 *   0 = +X, 1 = -X, 2 = +Y (top), 3 = -Y (bottom), 4 = +Z, 5 = -Z
 */

export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;

/** Geometry style. Cubes are greedy-meshed; crosses are billboarded quads. */
export const Render = {
  NONE: 0,
  CUBE: 1,
  CROSS: 2,
  LIQUID: 3,
};

/** Which palette the mesher should tint this block's vertices with. */
export const Tint = {
  NONE: 0,
  GRASS: 1,
  FOLIAGE: 2,
  WATER: 3,
};

/**
 * Which draw pass a block's geometry belongs to. Each bucket gets its own
 * material and its own sorting rules.
 */
export const Bucket = {
  OPAQUE: 0,
  CUTOUT: 1,
  TRANSPARENT: 2,
};

const registry = [];
const byName = new Map();

/**
 * Declare a block. `textures` accepts several shorthands:
 *   'stone'                                  -> all six faces
 *   { top, bottom, side }                    -> column style
 *   { top, bottom, px, nx, pz, nz }          -> fully explicit
 */
function define(id, name, options = {}) {
  const {
    display = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    render = Render.CUBE,
    solid = render === Render.CUBE,
    opaque = render === Render.CUBE,
    lightLevel = 0,
    lightFilter = opaque ? 15 : 0,
    hardness = 1,
    tool = null,
    tint = Tint.NONE,
    textures = 'stone',
    sound = 'stone',
    drops = undefined,
    flammable = false,
    replaceable = false,
    bucket = defaultBucket(render, opaque),
    // Whether identical neighbours hide each other's shared face. True for
    // liquids and glass so large volumes stay hollow; false for leaves, whose
    // interior faces are visible through the cutout holes.
    selfCull = render === Render.LIQUID,
    // How far the vertex shader sways this block in the wind, 0..1.
    sway = 0,
  } = options;

  const faces = resolveTextures(textures);
  const block = {
    id,
    name,
    display,
    render,
    solid,
    opaque,
    lightLevel,
    lightFilter,
    hardness,
    tool,
    tint,
    textures: faces,
    // Filled in by the atlas once tile indices are known.
    tiles: new Int16Array(6).fill(-1),
    sound,
    drops: drops === undefined ? id : drops,
    flammable,
    replaceable,
    bucket,
    selfCull,
    sway: Math.round(Math.max(0, Math.min(1, sway)) * 255),
  };

  registry[id] = block;
  byName.set(name, block);
  return block;
}

function defaultBucket(render, opaque) {
  if (render === Render.CROSS) return Bucket.CUTOUT;
  if (render === Render.LIQUID) return Bucket.TRANSPARENT;
  return opaque ? Bucket.OPAQUE : Bucket.CUTOUT;
}

function resolveTextures(textures) {
  if (typeof textures === 'string') {
    return [textures, textures, textures, textures, textures, textures];
  }
  const side = textures.side ?? textures.all ?? 'stone';
  return [
    textures.px ?? side,
    textures.nx ?? side,
    textures.top ?? textures.all ?? side,
    textures.bottom ?? textures.top ?? textures.all ?? side,
    textures.pz ?? side,
    textures.nz ?? side,
  ];
}

// ---------------------------------------------------------------------------
// Block definitions
// ---------------------------------------------------------------------------

export const AIR = 0;
export const STONE = 1;
export const GRASS_BLOCK = 2;
export const DIRT = 3;
export const COBBLESTONE = 4;
export const SAND = 5;
export const GRAVEL = 6;
export const OAK_LOG = 7;
export const OAK_LEAVES = 8;
export const OAK_PLANKS = 9;
export const WATER = 10;
export const SANDSTONE = 11;
export const SNOW_BLOCK = 12;
export const ICE = 13;
export const CLAY = 14;
export const BEDROCK = 15;
export const COAL_ORE = 16;
export const IRON_ORE = 17;
export const GOLD_ORE = 18;
export const DIAMOND_ORE = 19;
export const REDSTONE_ORE = 20;
export const LAPIS_ORE = 21;
export const GLASS = 22;
export const TORCH = 23;
export const GLOWSTONE = 24;
export const LAVA = 25;
export const BIRCH_LOG = 26;
export const BIRCH_LEAVES = 27;
export const SPRUCE_LOG = 28;
export const SPRUCE_LEAVES = 29;
export const CHERRY_LOG = 30;
export const CHERRY_LEAVES = 31;
export const CACTUS = 32;
export const GRASS_BLADE = 33;
export const FLOWER_POPPY = 34;
export const FLOWER_DANDELION = 35;
export const FLOWER_CORNFLOWER = 36;
export const FERN = 37;
export const DEAD_BUSH = 38;
export const MOSSY_COBBLESTONE = 39;
export const STONE_BRICKS = 40;
export const PODZOL = 41;
export const OBSIDIAN = 42;
export const BASALT = 43;
export const TERRACOTTA = 44;
export const RED_TERRACOTTA = 45;
export const ORANGE_TERRACOTTA = 46;
export const PACKED_ICE = 47;
export const CRAFTING_TABLE = 48;
export const FURNACE = 49;
export const CHEST = 50;
export const SNOW_LAYER = 51;
export const SUGAR_CANE = 52;
export const PUMPKIN = 53;
export const MELON = 54;
export const BOOKSHELF = 55;
export const BRICKS = 56;
export const COARSE_DIRT = 57;
export const MUD = 58;
export const MOSS_BLOCK = 59;
export const AMETHYST = 60;

define(AIR, 'air', {
  render: Render.NONE,
  solid: false,
  opaque: false,
  lightFilter: 0,
  hardness: 0,
  replaceable: true,
  textures: 'air',
});

define(STONE, 'stone', {
  hardness: 1.5, tool: 'pickaxe', textures: 'stone', drops: COBBLESTONE,
});
define(GRASS_BLOCK, 'grass_block', {
  hardness: 0.6, tool: 'shovel', sound: 'grass', tint: Tint.GRASS, drops: DIRT,
  textures: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' },
});
define(DIRT, 'dirt', { hardness: 0.5, tool: 'shovel', sound: 'gravel', textures: 'dirt' });
define(COARSE_DIRT, 'coarse_dirt', { hardness: 0.5, tool: 'shovel', sound: 'gravel', textures: 'coarse_dirt' });
define(COBBLESTONE, 'cobblestone', { hardness: 2, tool: 'pickaxe', textures: 'cobblestone' });
define(SAND, 'sand', { hardness: 0.5, tool: 'shovel', sound: 'sand', textures: 'sand' });
define(GRAVEL, 'gravel', { hardness: 0.6, tool: 'shovel', sound: 'gravel', textures: 'gravel' });
define(CLAY, 'clay', { hardness: 0.6, tool: 'shovel', sound: 'gravel', textures: 'clay' });
define(MUD, 'mud', { hardness: 0.5, tool: 'shovel', sound: 'gravel', textures: 'mud' });
define(BEDROCK, 'bedrock', { hardness: -1, textures: 'bedrock', drops: null });

define(OAK_LOG, 'oak_log', {
  hardness: 2, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'oak_log_top', side: 'oak_log_side' },
});
define(BIRCH_LOG, 'birch_log', {
  hardness: 2, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'birch_log_top', side: 'birch_log_side' },
});
define(SPRUCE_LOG, 'spruce_log', {
  hardness: 2, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'spruce_log_top', side: 'spruce_log_side' },
});
define(CHERRY_LOG, 'cherry_log', {
  hardness: 2, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'cherry_log_top', side: 'cherry_log_side' },
});

// Leaves are non-opaque so light filters through and interiors stay lit, but
// still cull against each other to keep dense canopies cheap.
const leafOptions = {
  hardness: 0.2, sound: 'grass', opaque: false, solid: true,
  lightFilter: 2, tint: Tint.FOLIAGE, flammable: true, drops: null,
  sway: 0.42,
};
define(OAK_LEAVES, 'oak_leaves', { ...leafOptions, textures: 'oak_leaves' });
define(BIRCH_LEAVES, 'birch_leaves', { ...leafOptions, textures: 'birch_leaves' });
define(SPRUCE_LEAVES, 'spruce_leaves', { ...leafOptions, textures: 'spruce_leaves' });
define(CHERRY_LEAVES, 'cherry_leaves', { ...leafOptions, tint: Tint.NONE, textures: 'cherry_leaves' });

define(OAK_PLANKS, 'oak_planks', { hardness: 2, tool: 'axe', sound: 'wood', flammable: true, textures: 'oak_planks' });
define(BOOKSHELF, 'bookshelf', {
  hardness: 1.5, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'oak_planks', side: 'bookshelf' },
});
define(CRAFTING_TABLE, 'crafting_table', {
  hardness: 2.5, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side' },
});
define(FURNACE, 'furnace', {
  hardness: 3.5, tool: 'pickaxe',
  textures: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', nz: 'furnace_front' },
});
define(CHEST, 'chest', {
  hardness: 2.5, tool: 'axe', sound: 'wood', flammable: true,
  textures: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', nz: 'chest_front' },
});

define(WATER, 'water', {
  render: Render.LIQUID, solid: false, opaque: false, lightFilter: 1,
  hardness: -1, tint: Tint.WATER, sound: 'water', replaceable: true,
  textures: 'water', drops: null,
});
define(LAVA, 'lava', {
  render: Render.LIQUID, solid: false, opaque: false, lightFilter: 0,
  lightLevel: 15, hardness: -1, sound: 'lava', replaceable: true,
  // Lava is fully opaque even though it is a liquid, so it draws in the opaque
  // pass and avoids the cost and sorting problems of the transparent one.
  bucket: Bucket.OPAQUE,
  textures: 'lava', drops: null,
});

define(SANDSTONE, 'sandstone', {
  hardness: 0.8, tool: 'pickaxe',
  textures: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone_side' },
});
define(SNOW_BLOCK, 'snow_block', { hardness: 0.2, tool: 'shovel', sound: 'snow', textures: 'snow' });
define(SNOW_LAYER, 'snow_layer', {
  hardness: 0.1, tool: 'shovel', sound: 'snow', opaque: false, solid: false,
  render: Render.CROSS, textures: 'snow', drops: null,
});
define(ICE, 'ice', {
  hardness: 0.5, tool: 'pickaxe', opaque: false, lightFilter: 2,
  sound: 'glass', textures: 'ice', drops: null, selfCull: true,
});
define(PACKED_ICE, 'packed_ice', { hardness: 0.5, tool: 'pickaxe', sound: 'glass', textures: 'packed_ice' });

define(COAL_ORE, 'coal_ore', { hardness: 3, tool: 'pickaxe', textures: 'coal_ore' });
define(IRON_ORE, 'iron_ore', { hardness: 3, tool: 'pickaxe', textures: 'iron_ore' });
define(GOLD_ORE, 'gold_ore', { hardness: 3, tool: 'pickaxe', textures: 'gold_ore' });
define(DIAMOND_ORE, 'diamond_ore', { hardness: 3, tool: 'pickaxe', textures: 'diamond_ore' });
define(REDSTONE_ORE, 'redstone_ore', { hardness: 3, tool: 'pickaxe', textures: 'redstone_ore' });
define(LAPIS_ORE, 'lapis_ore', { hardness: 3, tool: 'pickaxe', textures: 'lapis_ore' });
define(AMETHYST, 'amethyst_block', { hardness: 1.5, tool: 'pickaxe', sound: 'glass', lightLevel: 3, textures: 'amethyst' });

define(GLASS, 'glass', {
  hardness: 0.3, opaque: false, lightFilter: 0, sound: 'glass',
  textures: 'glass', drops: null, selfCull: true,
});
define(GLOWSTONE, 'glowstone', {
  hardness: 0.3, lightLevel: 15, sound: 'glass', textures: 'glowstone',
});
define(TORCH, 'torch', {
  render: Render.CROSS, solid: false, opaque: false, lightLevel: 14,
  hardness: 0, sound: 'wood', textures: 'torch',
});

define(MOSSY_COBBLESTONE, 'mossy_cobblestone', { hardness: 2, tool: 'pickaxe', textures: 'mossy_cobblestone' });
define(STONE_BRICKS, 'stone_bricks', { hardness: 1.5, tool: 'pickaxe', textures: 'stone_bricks' });
define(BRICKS, 'bricks', { hardness: 2, tool: 'pickaxe', textures: 'bricks' });
define(PODZOL, 'podzol', {
  hardness: 0.5, tool: 'shovel', sound: 'grass',
  textures: { top: 'podzol_top', bottom: 'dirt', side: 'podzol_side' },
});
define(MOSS_BLOCK, 'moss_block', { hardness: 0.5, tool: 'shovel', sound: 'grass', textures: 'moss' });
define(OBSIDIAN, 'obsidian', { hardness: 12, tool: 'pickaxe', textures: 'obsidian' });
define(BASALT, 'basalt', {
  hardness: 1.5, tool: 'pickaxe',
  textures: { top: 'basalt_top', side: 'basalt_side' },
});
define(TERRACOTTA, 'terracotta', { hardness: 1.5, tool: 'pickaxe', textures: 'terracotta' });
define(RED_TERRACOTTA, 'red_terracotta', { hardness: 1.5, tool: 'pickaxe', textures: 'red_terracotta' });
define(ORANGE_TERRACOTTA, 'orange_terracotta', { hardness: 1.5, tool: 'pickaxe', textures: 'orange_terracotta' });

define(CACTUS, 'cactus', {
  hardness: 0.4, sound: 'grass', opaque: false,
  textures: { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' },
});
define(PUMPKIN, 'pumpkin', {
  hardness: 1, tool: 'axe', sound: 'grass',
  textures: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' },
});
define(MELON, 'melon', {
  hardness: 1, tool: 'axe', sound: 'grass',
  textures: { top: 'melon_top', bottom: 'melon_top', side: 'melon_side' },
});

const plantOptions = {
  render: Render.CROSS, solid: false, opaque: false, lightFilter: 0,
  hardness: 0, sound: 'grass', flammable: true, replaceable: true,
  sway: 1,
};
define(GRASS_BLADE, 'short_grass', { ...plantOptions, tint: Tint.GRASS, textures: 'grass_blade', drops: null });
define(FERN, 'fern', { ...plantOptions, tint: Tint.GRASS, textures: 'fern', drops: null });
define(FLOWER_POPPY, 'poppy', { ...plantOptions, textures: 'poppy' });
define(FLOWER_DANDELION, 'dandelion', { ...plantOptions, textures: 'dandelion' });
define(FLOWER_CORNFLOWER, 'cornflower', { ...plantOptions, textures: 'cornflower' });
define(DEAD_BUSH, 'dead_bush', { ...plantOptions, textures: 'dead_bush', drops: null });
define(SUGAR_CANE, 'sugar_cane', { ...plantOptions, tint: Tint.FOLIAGE, textures: 'sugar_cane', sway: 0.55 });

// ---------------------------------------------------------------------------
// Flat lookup tables
// ---------------------------------------------------------------------------

/** Highest defined block id, inclusive. */
export const BLOCK_COUNT = registry.length;

// Fill any gaps so indexing is always safe.
for (let i = 0; i < BLOCK_COUNT; i++) {
  if (!registry[i]) registry[i] = registry[AIR];
}

export const BLOCKS = registry;

/**
 * Structure-of-arrays view of the registry. These are what the mesher, lighting
 * and physics loops read, and what gets structured-cloned into workers.
 */
export function buildBlockTables() {
  const count = BLOCK_COUNT;
  const tables = {
    render: new Uint8Array(count),
    solid: new Uint8Array(count),
    opaque: new Uint8Array(count),
    lightLevel: new Uint8Array(count),
    lightFilter: new Uint8Array(count),
    tint: new Uint8Array(count),
    liquid: new Uint8Array(count),
    replaceable: new Uint8Array(count),
    bucket: new Uint8Array(count),
    selfCull: new Uint8Array(count),
    sway: new Uint8Array(count),
    // 6 tile indices per block, laid out face-major.
    tiles: new Int16Array(count * 6),
  };
  for (let id = 0; id < count; id++) {
    const b = registry[id];
    tables.render[id] = b.render;
    tables.solid[id] = b.solid ? 1 : 0;
    tables.opaque[id] = b.opaque ? 1 : 0;
    tables.lightLevel[id] = b.lightLevel;
    tables.lightFilter[id] = b.lightFilter;
    tables.tint[id] = b.tint;
    tables.liquid[id] = b.render === Render.LIQUID ? 1 : 0;
    tables.replaceable[id] = b.replaceable ? 1 : 0;
    tables.bucket[id] = b.bucket;
    tables.selfCull[id] = b.selfCull ? 1 : 0;
    tables.sway[id] = b.sway;
    for (let f = 0; f < 6; f++) tables.tiles[id * 6 + f] = b.tiles[f];
  }
  return tables;
}

export function getBlock(id) {
  return registry[id] ?? registry[AIR];
}

export function getBlockByName(name) {
  return byName.get(name) ?? null;
}

/** Every distinct texture name referenced by the registry, in stable order. */
export function collectTextureNames() {
  const names = [];
  const seen = new Set();
  for (const block of registry) {
    if (!block || block.id === AIR) continue;
    for (const name of block.textures) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/** Called by the atlas once it knows where each texture landed. */
export function assignTileIndices(tileIndexByName) {
  for (const block of registry) {
    if (!block) continue;
    for (let f = 0; f < 6; f++) {
      block.tiles[f] = tileIndexByName.get(block.textures[f]) ?? 0;
    }
  }
}

/** Blocks offered in the creative inventory, grouped for the picker UI. */
export const CREATIVE_GROUPS = [
  {
    name: 'Natural',
    blocks: [
      GRASS_BLOCK, DIRT, COARSE_DIRT, PODZOL, MOSS_BLOCK, MUD, STONE, COBBLESTONE,
      SAND, SANDSTONE, GRAVEL, CLAY, SNOW_BLOCK, ICE, PACKED_ICE, TERRACOTTA,
      RED_TERRACOTTA, ORANGE_TERRACOTTA, BASALT, OBSIDIAN, BEDROCK,
    ],
  },
  {
    name: 'Ores',
    blocks: [COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE, REDSTONE_ORE, LAPIS_ORE, AMETHYST],
  },
  {
    name: 'Wood',
    blocks: [
      OAK_LOG, BIRCH_LOG, SPRUCE_LOG, CHERRY_LOG, OAK_PLANKS, BOOKSHELF,
      OAK_LEAVES, BIRCH_LEAVES, SPRUCE_LEAVES, CHERRY_LEAVES,
    ],
  },
  {
    name: 'Plants',
    blocks: [
      GRASS_BLADE, FERN, FLOWER_POPPY, FLOWER_DANDELION, FLOWER_CORNFLOWER,
      DEAD_BUSH, CACTUS, SUGAR_CANE, PUMPKIN, MELON,
    ],
  },
  {
    name: 'Built',
    blocks: [
      STONE_BRICKS, MOSSY_COBBLESTONE, BRICKS, GLASS, GLOWSTONE, TORCH,
      CRAFTING_TABLE, FURNACE, CHEST,
    ],
  },
  {
    name: 'Liquids',
    blocks: [WATER, LAVA],
  },
];
