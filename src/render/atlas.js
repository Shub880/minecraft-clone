/**
 * Builds the block texture array.
 *
 * Textures live in a `DataArrayTexture` (one 32x32 layer per texture) rather
 * than a packed atlas. Two reasons, both of which a flat atlas cannot solve
 * without shader gymnastics:
 *
 *  - Greedy meshing emits quads spanning many blocks and relies on repeat
 *    wrapping; UVs above 1 wrap correctly per layer in an array texture.
 *  - Mipmaps never bleed between neighbouring textures, so distant terrain
 *    stays clean instead of turning into coloured mush.
 *
 * Alpha channel semantics differ by material, which is unambiguous because
 * opaque and cutout geometry are drawn with different shaders:
 *  - opaque textures: alpha is a *tint mask* (0 = tint this pixel, 255 = leave)
 *  - cutout textures: alpha is the cutout mask
 */

import * as THREE from 'three';
import { mulberry32, hashString } from '../core/rng.js';
import { Painter, TILE, tileableFbm } from './texture-paint.js';
import { collectTextureNames, assignTileIndices, BLOCKS } from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const C = {
  stone: [124, 124, 131],
  stoneDark: [88, 88, 96],
  stoneLight: [158, 158, 165],
  deepstone: [72, 72, 80],

  dirt: [124, 89, 61],
  dirtDark: [92, 65, 43],
  dirtLight: [149, 111, 78],

  sand: [222, 208, 160],
  sandDark: [192, 176, 128],
  sandstone: [214, 200, 152],

  gravel: [132, 128, 126],
  gravelDark: [98, 95, 94],

  clay: [160, 165, 175],
  mud: [70, 58, 50],

  bark: [98, 74, 46],
  barkDark: [66, 48, 30],
  barkLight: [130, 100, 64],
  woodCore: [166, 132, 86],
  woodCoreDark: [126, 98, 62],

  birchBark: [216, 214, 204],
  birchBarkDark: [140, 138, 128],
  birchCore: [204, 186, 148],

  spruceBark: [70, 50, 32],
  spruceBarkDark: [46, 32, 20],
  spruceCore: [122, 90, 58],

  cherryBark: [70, 52, 56],
  cherryBarkDark: [48, 34, 38],
  cherryCore: [188, 140, 138],
  cherryPetal: [244, 186, 206],
  cherryPetalDark: [220, 150, 178],

  planks: [172, 136, 90],
  planksDark: [124, 96, 60],

  leaf: [180, 180, 180],
  leafDark: [130, 130, 130],
  spruceLeaf: [150, 155, 150],

  grassBase: [214, 214, 214],
  grassDark: [168, 168, 168],
  grassFringe: [176, 176, 176],

  snow: [246, 250, 255],
  snowShadow: [214, 224, 238],
  ice: [168, 206, 240],
  iceLight: [206, 232, 252],
  packedIce: [148, 190, 232],

  water: [58, 108, 196],
  waterLight: [96, 148, 226],
  lava: [226, 108, 32],
  lavaBright: [255, 196, 76],
  lavaDark: [160, 52, 16],

  coal: [34, 34, 38],
  coalHi: [72, 72, 78],
  iron: [196, 152, 118],
  ironHi: [226, 196, 168],
  gold: [244, 206, 84],
  goldHi: [255, 238, 168],
  diamond: [96, 226, 226],
  diamondHi: [186, 250, 250],
  redstone: [206, 44, 44],
  redstoneHi: [246, 110, 96],
  lapis: [42, 78, 176],
  lapisHi: [92, 132, 220],
  amethyst: [150, 108, 214],
  amethystHi: [200, 168, 246],

  glass: [206, 232, 240],
  glowstone: [236, 200, 118],
  glowstoneHi: [255, 240, 186],

  moss: [96, 128, 62],
  mossDark: [66, 92, 42],
  podzol: [110, 78, 40],
  podzolTop: [128, 92, 44],

  obsidian: [26, 20, 38],
  obsidianHi: [72, 52, 104],
  basalt: [72, 72, 78],
  basaltDark: [48, 48, 54],

  terracotta: [152, 94, 68],
  redTerracotta: [142, 62, 46],
  orangeTerracotta: [186, 110, 52],
  bricks: [156, 84, 66],
  mortar: [178, 172, 164],

  cactus: [88, 132, 66],
  cactusDark: [62, 98, 46],
  cactusTop: [110, 156, 84],
  pumpkin: [214, 132, 38],
  pumpkinDark: [168, 96, 24],
  melon: [110, 148, 54],
  melonDark: [72, 106, 38],
  melonFlesh: [214, 84, 76],

  poppy: [214, 56, 52],
  dandelion: [246, 214, 68],
  cornflower: [90, 110, 214],
  deadBush: [128, 96, 52],
  cane: [150, 190, 120],

  skin: [226, 176, 138],
  skinShade: [196, 146, 110],
  hair: [72, 48, 32],
  shirt: [72, 128, 196],
  shirtDark: [50, 96, 154],
  pants: [56, 62, 96],
  shoe: [58, 52, 48],

  furnaceFront: [64, 64, 68],
  furnaceHole: [32, 30, 30],
  chestWood: [146, 106, 56],
  chestWoodDark: [104, 74, 38],
  chestMetal: [190, 168, 84],
  book1: [168, 62, 56],
  book2: [66, 96, 168],
  book3: [188, 168, 82],
  book4: [76, 138, 84],
};

const NO_TINT = 255;
const TINTED = 0;

// ---------------------------------------------------------------------------
// Painters
// ---------------------------------------------------------------------------

/**
 * Each entry paints one 32x32 texture. The painter is handed a seeded RNG so
 * textures are identical on every run and across the preview and game.
 */
const painters = {
  // --- Stone family -------------------------------------------------------
  stone: (p) => p.fill(C.stone).grain(0.13, 8, 3).blobs(C.stoneDark, 3, 7, 0.28)
    .blobs(C.stoneLight, 2, 5, 0.2).bevel(1.06, 0.93),

  cobblestone: (p) => p.fill(C.stone).grain(0.1, 8, 2)
    .cobbles(C.stoneDark, 3, 0.16, 0.18).bevel(1.08, 0.9),

  mossy_cobblestone: (p) => p.fill(C.stone).grain(0.1, 8, 2)
    .cobbles(C.stoneDark, 3, 0.16, 0.18)
    .blobs(C.moss, 5, 7, 0.62).blobs(C.mossDark, 3, 4, 0.4).bevel(1.08, 0.9),

  stone_bricks: (p) => p.fill(C.stone).grain(0.09, 8, 2)
    .bricks(C.stoneDark, 4, 0.8).blobs(C.stoneDark, 2, 4, 0.16).bevel(1.06, 0.92),

  bricks: (p) => p.fill(C.bricks).grain(0.11, 8, 2)
    .bricks(C.mortar, 4, 0.95).bevel(1.06, 0.9),

  bedrock: (p) => p.fill(C.deepstone).grain(0.3, 6, 3)
    .blobs([20, 20, 24], 6, 6, 0.6).blobs(C.stoneDark, 4, 5, 0.4).outline(0.8),

  basalt_side: (p) => p.fill(C.basalt).grain(0.12, 4, 2).streaks(C.basaltDark, 12, 0.4)
    .bevel(1.06, 0.92),
  basalt_top: (p) => p.fill(C.basalt).grain(0.12, 8, 3)
    .cobbles(C.basaltDark, 4, 0.2, 0.1).bevel(1.05, 0.94),

  obsidian: (p) => p.fill(C.obsidian).grain(0.22, 6, 3)
    .blobs(C.obsidianHi, 4, 5, 0.35).speckle(C.obsidianHi, 22, 0.5).bevel(1.15, 0.88),

  // --- Soils --------------------------------------------------------------
  dirt: (p) => p.fill(C.dirt).grain(0.16, 8, 3)
    .blobs(C.dirtDark, 4, 6, 0.3).blobs(C.dirtLight, 3, 4, 0.22).bevel(1.07, 0.9),

  coarse_dirt: (p) => p.fill(C.dirt).grain(0.2, 10, 3)
    .blobs(C.dirtDark, 6, 5, 0.42).speckle(C.gravelDark, 40, 0.5).bevel(1.05, 0.9),

  mud: (p) => p.fill(C.mud).grain(0.14, 6, 3).blobs([52, 44, 38], 4, 6, 0.4)
    .bevel(1.08, 0.88),

  clay: (p) => p.fill(C.clay).grain(0.09, 8, 3).blobs([142, 148, 158], 3, 6, 0.25)
    .bevel(1.05, 0.93),

  gravel: (p) => p.fill(C.gravel).grain(0.14, 10, 3)
    .cobbles(C.gravelDark, 5, 0.24, 0.2).speckle(C.stoneLight, 26, 0.4).bevel(1.05, 0.92),

  sand: (p) => p.fill(C.sand).grain(0.08, 12, 3)
    .speckle(C.sandDark, 60, 0.35).speckle([255, 250, 226], 30, 0.5).bevel(1.05, 0.94),

  sandstone_top: (p) => p.fill(C.sandstone).grain(0.07, 10, 3)
    .speckle(C.sandDark, 40, 0.3).bevel(1.05, 0.94),
  sandstone_side: (p) => {
    p.fill(C.sandstone).grain(0.06, 4, 2);
    // Horizontal sedimentary banding.
    const bands = tileableFbm(p.size, 2, 2, p.rand);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const band = Math.sin(y * 0.85 + bands[y * p.size + x] * 3.2);
        if (band > 0.3) p.blend(x, y, C.sandDark, (band - 0.3) * 0.5);
      }
    }
    return p.bevel(1.06, 0.9);
  },
  sandstone_bottom: (p) => p.fill(C.sandstone).grain(0.1, 8, 3)
    .blobs(C.sandDark, 4, 5, 0.3).bevel(1.04, 0.94),

  terracotta: (p) => p.fill(C.terracotta).grain(0.1, 8, 3)
    .blobs([132, 80, 58], 3, 6, 0.25).bevel(1.06, 0.92),
  red_terracotta: (p) => p.fill(C.redTerracotta).grain(0.1, 8, 3)
    .blobs([120, 50, 38], 3, 6, 0.25).bevel(1.06, 0.92),
  orange_terracotta: (p) => p.fill(C.orangeTerracotta).grain(0.1, 8, 3)
    .blobs([160, 92, 42], 3, 6, 0.25).bevel(1.06, 0.92),

  // --- Grass --------------------------------------------------------------
  // Painted greyscale with alpha 0 so the biome tint fully drives the colour.
  grass_top: (p) => {
    p.fill(C.grassBase, TINTED).grain(0.13, 10, 3);
    // Short vertical blade strokes give the surface direction.
    for (let i = 0; i < 46; i++) {
      const x = Math.floor(p.rand() * p.size);
      const y = Math.floor(p.rand() * p.size);
      const len = 2 + Math.floor(p.rand() * 3);
      const dark = p.rand() < 0.5;
      for (let k = 0; k < len; k++) {
        p.blend(x, (y + k) % p.size, dark ? C.grassDark : [246, 246, 246], 0.3);
      }
    }
    return p.blobs(C.grassDark, 3, 6, 0.16);
  },

  grass_side: (p) => {
    // Dirt body stays untinted (alpha 255); the fringe is tint-masked.
    p.fill(C.dirt, NO_TINT).grain(0.15, 8, 3).blobs(C.dirtDark, 3, 5, 0.28);
    const edge = tileableFbm(p.size, 4, 2, p.rand);
    for (let x = 0; x < p.size; x++) {
      // Ragged grass line, roughly a third of the way down the block.
      const depth = 8 + Math.round(edge[x] * 7);
      for (let y = 0; y < depth; y++) {
        const shade = 0.82 + (1 - y / depth) * 0.34;
        const v = C.grassFringe[0] * shade;
        p.set(x, y, v, v, v, TINTED);
      }
      // A few blades hanging below the main line.
      if (p.rand() < 0.4) {
        const extra = depth + 1 + Math.floor(p.rand() * 3);
        for (let y = depth; y < Math.min(extra, p.size); y++) {
          const v = C.grassDark[0];
          p.set(x, y, v, v, v, TINTED);
        }
      }
    }
    return p.bevel(1.08, 0.88);
  },

  podzol_top: (p) => p.fill(C.podzolTop).grain(0.16, 10, 3)
    .blobs([88, 62, 32], 4, 5, 0.35).speckle([160, 122, 62], 30, 0.4).bevel(1.06, 0.9),
  podzol_side: (p) => {
    p.fill(C.dirt).grain(0.15, 8, 3).blobs(C.dirtDark, 3, 5, 0.28);
    const edge = tileableFbm(p.size, 4, 2, p.rand);
    for (let x = 0; x < p.size; x++) {
      const depth = 6 + Math.round(edge[x] * 5);
      for (let y = 0; y < depth; y++) p.blend(x, y, C.podzol, 0.9);
    }
    return p.bevel(1.07, 0.9);
  },
  moss: (p) => p.fill(C.moss).grain(0.18, 10, 3)
    .blobs(C.mossDark, 5, 5, 0.4).speckle([132, 168, 84], 34, 0.4).bevel(1.06, 0.9),

  // --- Wood ---------------------------------------------------------------
  oak_log_side: (p) => p.fill(C.bark).grain(0.14, 4, 2)
    .streaks(C.barkDark, 9, 0.42).streaks(C.barkLight, 4, 0.22).bevel(1.07, 0.88),
  oak_log_top: (p) => p.fill(C.woodCore).grain(0.09, 8, 2)
    .rings(C.woodCoreDark, 5, 0.45).outline(0.84),

  birch_log_side: (p) => {
    p.fill(C.birchBark).grain(0.06, 4, 2);
    // Birch's characteristic horizontal dashes.
    for (let i = 0; i < 7; i++) {
      const y = Math.floor(p.rand() * p.size);
      const x0 = Math.floor(p.rand() * p.size);
      const len = 3 + Math.floor(p.rand() * 7);
      const h = p.rand() < 0.4 ? 2 : 1;
      for (let k = 0; k < len; k++) {
        for (let dy = 0; dy < h; dy++) {
          p.blend((x0 + k) % p.size, (y + dy) % p.size, C.birchBarkDark, 0.75);
        }
      }
    }
    return p.bevel(1.05, 0.9);
  },
  birch_log_top: (p) => p.fill(C.birchCore).grain(0.08, 8, 2)
    .rings([166, 148, 112], 5, 0.4).outline(0.86),

  spruce_log_side: (p) => p.fill(C.spruceBark).grain(0.16, 4, 2)
    .streaks(C.spruceBarkDark, 11, 0.5).bevel(1.09, 0.86),
  spruce_log_top: (p) => p.fill(C.spruceCore).grain(0.09, 8, 2)
    .rings([94, 68, 42], 6, 0.45).outline(0.84),

  cherry_log_side: (p) => p.fill(C.cherryBark).grain(0.14, 4, 2)
    .streaks(C.cherryBarkDark, 9, 0.45).bevel(1.08, 0.88),
  cherry_log_top: (p) => p.fill(C.cherryCore).grain(0.08, 8, 2)
    .rings([158, 112, 112], 5, 0.4).outline(0.86),

  oak_planks: (p) => p.fill(C.planks).grain(0.1, 4, 2)
    .streaks(C.planksDark, 6, 0.2).planks(C.planksDark, 4, 0.7).bevel(1.06, 0.9),

  bookshelf: (p) => {
    p.fill(C.planks).grain(0.08, 4, 2).streaks(C.planksDark, 4, 0.18);
    // Wooden frame top and bottom, books filling the middle two shelves.
    p.rect(0, 0, p.size, 5, C.planks, 1).rect(0, p.size - 5, p.size, 5, C.planks, 1);
    p.rect(0, 14, p.size, 4, C.planks, 1);
    const books = [C.book1, C.book2, C.book3, C.book4];
    for (const shelfY of [5, 18]) {
      let x = 0;
      while (x < p.size) {
        const w = 2 + Math.floor(p.rand() * 3);
        const h = 7 + Math.floor(p.rand() * 3);
        const color = books[Math.floor(p.rand() * books.length)];
        p.rect(x, shelfY + (9 - h), Math.min(w, p.size - x), h, color, 1);
        p.strokeRect(x, shelfY + (9 - h), Math.min(w, p.size - x), h, [0, 0, 0], 0.22);
        x += w + 1;
      }
    }
    return p.bevel(1.05, 0.9);
  },

  crafting_table_top: (p) => {
    p.fill(C.planks).grain(0.08, 4, 2).planks(C.planksDark, 2, 0.5);
    // 3x3 crafting grid etched into the surface.
    for (let i = 0; i <= 3; i++) {
      const o = 4 + i * 8;
      for (let k = 4; k < 28; k++) {
        p.blend(o, k, C.planksDark, 0.7);
        p.blend(k, o, C.planksDark, 0.7);
      }
    }
    return p.bevel(1.05, 0.9);
  },
  crafting_table_side: (p) => {
    p.fill(C.planks).grain(0.08, 4, 2).planks(C.planksDark, 4, 0.6);
    p.rect(4, 12, 10, 8, C.planksDark, 0.55);
    p.rect(18, 12, 10, 8, C.planksDark, 0.55);
    return p.bevel(1.05, 0.9);
  },

  furnace_top: (p) => p.fill(C.stone).grain(0.1, 8, 2).cobbles(C.stoneDark, 3, 0.14, 0.12)
    .rect(9, 9, 14, 14, C.basalt, 0.6).bevel(1.05, 0.92),
  furnace_side: (p) => p.fill(C.stone).grain(0.1, 8, 2)
    .cobbles(C.stoneDark, 3, 0.14, 0.12).bevel(1.06, 0.9),
  furnace_front: (p) => {
    p.fill(C.stone).grain(0.1, 8, 2).cobbles(C.stoneDark, 3, 0.14, 0.12);
    p.rect(6, 12, 20, 14, C.furnaceFront, 1);
    p.rect(8, 14, 16, 10, C.furnaceHole, 1);
    // Grate bars.
    for (let x = 9; x < 24; x += 3) p.rect(x, 14, 1, 10, C.furnaceFront, 0.8);
    return p.bevel(1.06, 0.9);
  },

  chest_top: (p) => p.fill(C.chestWood).grain(0.1, 4, 2).planks(C.chestWoodDark, 4, 0.5)
    .rect(13, 0, 6, 8, C.chestMetal, 1).bevel(1.05, 0.9),
  chest_side: (p) => p.fill(C.chestWood).grain(0.1, 4, 2)
    .rect(0, 12, p.size, 3, C.chestWoodDark, 0.8)
    .planks(C.chestWoodDark, 4, 0.35).bevel(1.06, 0.9),
  chest_front: (p) => {
    p.fill(C.chestWood).grain(0.1, 4, 2);
    p.rect(0, 12, p.size, 3, C.chestWoodDark, 0.85);
    p.rect(13, 12, 6, 8, C.chestMetal, 1);
    p.rect(15, 15, 2, 3, [40, 34, 20], 1);
    return p.bevel(1.06, 0.9);
  },

  // --- Leaves (cutout: alpha is the cutout mask) --------------------------
  oak_leaves: (p) => leafTexture(p, C.leaf, C.leafDark, 0.2),
  birch_leaves: (p) => leafTexture(p, [196, 196, 196], [146, 146, 146], 0.22),
  spruce_leaves: (p) => leafTexture(p, C.spruceLeaf, [110, 118, 110], 0.3),
  cherry_leaves: (p) => leafTexture(p, C.cherryPetal, C.cherryPetalDark, 0.24),

  // --- Liquids ------------------------------------------------------------
  water: (p) => {
    p.fill(C.water).grain(0.1, 4, 3);
    const swell = tileableFbm(p.size, 4, 3, p.rand);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const n = swell[y * p.size + x];
        if (n > 0.62) p.blend(x, y, C.waterLight, (n - 0.62) * 1.6);
      }
    }
    return p;
  },
  lava: (p) => {
    p.fill(C.lava).grain(0.14, 4, 3);
    const heat = tileableFbm(p.size, 3, 3, p.rand);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        const n = heat[y * p.size + x];
        if (n > 0.58) p.blend(x, y, C.lavaBright, (n - 0.58) * 2.2);
        else if (n < 0.34) p.blend(x, y, C.lavaDark, (0.34 - n) * 1.8);
      }
    }
    return p;
  },

  // --- Ice and snow -------------------------------------------------------
  snow: (p) => p.fill(C.snow).grain(0.05, 10, 3)
    .blobs(C.snowShadow, 3, 6, 0.3).speckle([255, 255, 255], 30, 0.7).bevel(1.03, 0.94),
  ice: (p) => {
    p.fill(C.ice, 200).grain(0.08, 6, 3).blobs(C.iceLight, 4, 7, 0.4);
    // Fracture lines.
    for (let i = 0; i < 4; i++) {
      let x = Math.floor(p.rand() * p.size);
      let y = Math.floor(p.rand() * p.size);
      const steps = 8 + Math.floor(p.rand() * 12);
      for (let s = 0; s < steps; s++) {
        p.blend(x, y, [236, 250, 255], 0.55);
        x = (x + (p.rand() < 0.5 ? 1 : 0) + p.size) % p.size;
        y = (y + 1) % p.size;
      }
    }
    return p.bevel(1.06, 0.94);
  },
  packed_ice: (p) => p.fill(C.packedIce).grain(0.09, 8, 3)
    .blobs(C.iceLight, 4, 6, 0.3).bevel(1.05, 0.93),

  // --- Ores ---------------------------------------------------------------
  coal_ore: (p) => oreTexture(p, C.coal, C.coalHi, 4),
  iron_ore: (p) => oreTexture(p, C.iron, C.ironHi, 4),
  gold_ore: (p) => oreTexture(p, C.gold, C.goldHi, 4),
  diamond_ore: (p) => oreTexture(p, C.diamond, C.diamondHi, 5),
  redstone_ore: (p) => oreTexture(p, C.redstone, C.redstoneHi, 5),
  lapis_ore: (p) => oreTexture(p, C.lapis, C.lapisHi, 4),
  amethyst: (p) => p.fill(C.amethyst).grain(0.14, 6, 3)
    .blobs(C.amethystHi, 5, 6, 0.45).speckle([232, 214, 255], 20, 0.6).bevel(1.12, 0.86),

  // --- Light and glass ----------------------------------------------------
  glass: (p) => {
    p.fill(C.glass, 26);
    // Only the frame and a highlight streak are solid.
    for (let i = 0; i < p.size; i++) {
      p.set(i, 0, 236, 250, 255, 210);
      p.set(i, p.size - 1, 200, 224, 236, 210);
      p.set(0, i, 236, 250, 255, 210);
      p.set(p.size - 1, i, 200, 224, 236, 210);
    }
    for (let k = 0; k < 9; k++) p.set(6 + k, 6 + k, 255, 255, 255, 150);
    for (let k = 0; k < 5; k++) p.set(20 + k, 8 + k, 255, 255, 255, 110);
    return p;
  },
  glowstone: (p) => p.fill(C.glowstone).grain(0.1, 8, 3)
    .blobs(C.glowstoneHi, 6, 5, 0.6).speckle([255, 252, 226], 26, 0.7).bevel(1.1, 0.9),

  torch: (p) => {
    p.clear();
    // Stick.
    for (let y = 14; y < p.size; y++) {
      for (let x = 14; x < 18; x++) {
        const shade = x < 16 ? 1 : 0.78;
        p.set(x, y, C.bark[0] * shade, C.bark[1] * shade, C.bark[2] * shade, 255);
      }
    }
    // Flame head.
    for (let y = 9; y < 15; y++) {
      for (let x = 13; x < 19; x++) {
        const t = (y - 9) / 6;
        const c = t < 0.4 ? C.lavaBright : C.lava;
        p.set(x, y, c[0], c[1], c[2], 255);
      }
    }
    for (let x = 14; x < 18; x++) p.set(x, 8, 255, 246, 200, 255);
    return p;
  },

  // --- Plants (cutout) ----------------------------------------------------
  grass_blade: (p) => plantTexture(p, {
    color: [196, 196, 196], dark: [150, 150, 150], blades: 9, height: 15, base: 30,
  }),
  fern: (p) => plantTexture(p, {
    color: [186, 186, 186], dark: [140, 140, 140], blades: 7, height: 20, base: 30, spread: 9,
  }),
  poppy: (p) => flowerTexture(p, C.poppy, [246, 120, 110], [40, 30, 30]),
  dandelion: (p) => flowerTexture(p, C.dandelion, [255, 244, 150], [200, 170, 40]),
  cornflower: (p) => flowerTexture(p, C.cornflower, [140, 160, 244], [50, 60, 140]),
  dead_bush: (p) => plantTexture(p, {
    color: C.deadBush, dark: [96, 70, 36], blades: 8, height: 17, base: 30, spread: 11, curve: 2.2,
  }),
  sugar_cane: (p) => {
    p.clear();
    for (let y = 0; y < p.size; y++) {
      for (let x = 13; x < 19; x++) {
        const shade = x < 15 ? 1.1 : x > 17 ? 0.8 : 1;
        const seg = y % 8 < 1 ? 0.75 : 1;
        p.set(x, y, C.cane[0] * shade * seg, C.cane[1] * shade * seg, C.cane[2] * shade * seg, 255);
      }
    }
    return p;
  },

  // --- Cactus, gourds -----------------------------------------------------
  cactus_side: (p) => {
    p.fill(C.cactus).grain(0.09, 6, 2);
    for (let y = 0; y < p.size; y++) {
      p.blend(1, y, C.cactusDark, 0.7);
      p.blend(p.size - 2, y, C.cactusDark, 0.7);
    }
    // Spines.
    for (let i = 0; i < 16; i++) {
      const x = 4 + Math.floor(p.rand() * 24);
      const y = Math.floor(p.rand() * p.size);
      p.blend(x, y, [226, 226, 200], 0.85);
      p.blend(x, (y + 1) % p.size, [180, 180, 150], 0.5);
    }
    return p.bevel(1.05, 0.9);
  },
  cactus_top: (p) => p.fill(C.cactusTop).grain(0.1, 6, 2)
    .blobs(C.cactusDark, 3, 5, 0.3).outline(0.85),
  cactus_bottom: (p) => p.fill(C.cactusDark).grain(0.1, 6, 2).outline(0.85),

  pumpkin_side: (p) => {
    p.fill(C.pumpkin).grain(0.09, 4, 2);
    for (let x = 4; x < p.size; x += 7) {
      for (let y = 0; y < p.size; y++) p.blend(x, y, C.pumpkinDark, 0.6);
    }
    return p.bevel(1.07, 0.88);
  },
  pumpkin_top: (p) => {
    p.fill(C.pumpkin).grain(0.09, 6, 2).blobs(C.pumpkinDark, 4, 6, 0.3);
    p.rect(13, 13, 6, 6, C.bark, 1);
    return p.bevel(1.05, 0.9);
  },

  melon_side: (p) => {
    p.fill(C.melon).grain(0.1, 4, 2);
    const stripes = tileableFbm(p.size, 3, 2, p.rand);
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        if (stripes[y * p.size + x] > 0.55) p.blend(x, y, C.melonDark, 0.55);
      }
    }
    return p.bevel(1.06, 0.9);
  },
  melon_top: (p) => p.fill(C.melon).grain(0.1, 6, 2)
    .blobs(C.melonFlesh, 3, 6, 0.35).bevel(1.05, 0.92),

  // --- Player skin --------------------------------------------------------
  // Not referenced by any block; used by the held-item view model and the
  // third-person avatar, which share this atlas rather than a second texture.
  skin_face: (p) => {
    p.fill(C.skin).grain(0.05, 6, 2);
    p.rect(0, 0, p.size, 9, C.hair, 1).rect(0, 0, 3, 14, C.hair, 1)
      .rect(p.size - 3, 0, 3, 14, C.hair, 1);
    // Eyes: white with a coloured iris, offset from centre so the face reads.
    p.rect(7, 13, 5, 4, [244, 244, 250], 1).rect(20, 13, 5, 4, [244, 244, 250], 1);
    p.rect(9, 13, 3, 4, [70, 96, 150], 1).rect(20, 13, 3, 4, [70, 96, 150], 1);
    p.rect(12, 22, 8, 2, C.skinShade, 0.75);
    return p.bevel(1.04, 0.92);
  },
  skin_head: (p) => {
    p.fill(C.skin).grain(0.05, 6, 2);
    p.rect(0, 0, p.size, 9, C.hair, 1);
    return p.bevel(1.04, 0.92);
  },
  skin_hair: (p) => p.fill(C.hair).grain(0.12, 8, 3)
    .blobs([54, 36, 24], 4, 6, 0.4).bevel(1.08, 0.9),
  skin_body: (p) => {
    p.fill(C.shirt).grain(0.07, 6, 2);
    p.rect(0, 0, p.size, 4, C.shirtDark, 0.85);
    p.rect(13, 4, 6, p.size - 4, C.shirtDark, 0.35);
    return p.bevel(1.06, 0.9);
  },
  skin_arm: (p) => {
    p.fill(C.shirt).grain(0.07, 6, 2);
    // Sleeve ends two thirds down; the rest is the hand.
    p.rect(0, 20, p.size, 12, C.skin, 1);
    p.rect(0, 19, p.size, 2, C.shirtDark, 0.7);
    return p.bevel(1.06, 0.9);
  },
  skin_leg: (p) => {
    p.fill(C.pants).grain(0.07, 6, 2);
    p.rect(0, 26, p.size, 6, C.shoe, 1);
    return p.bevel(1.06, 0.9);
  },
};

// ---------------------------------------------------------------------------
// Shared painter helpers
// ---------------------------------------------------------------------------

/** Leaves: dense clumps with genuine gaps so canopies read as foliage. */
function leafTexture(p, base, dark, holeChance) {
  p.fill(base, 255).grain(0.2, 8, 3);
  const clump = tileableFbm(p.size, 6, 3, p.rand);
  for (let y = 0; y < p.size; y++) {
    for (let x = 0; x < p.size; x++) {
      const n = clump[y * p.size + x];
      if (n < 0.42) p.blend(x, y, dark, (0.42 - n) * 1.8);
      else if (n > 0.66) p.blend(x, y, [235, 235, 235], (n - 0.66) * 1.1);
      // Punch holes where the field is thinnest, plus scattered pinholes.
      if (n < 0.3 || p.rand() < holeChance * 0.28) {
        p.px[p.index(x, y) + 3] = 0;
      }
    }
  }
  return p;
}

/** Ore: stone base with an embedded vein of the ore colour. */
function oreTexture(p, color, highlight, clusters) {
  painters.stone(p);
  return p.oreVein(color, highlight, clusters);
}

/** A fan of blades rising from the bottom of the tile. */
function plantTexture(p, { color, dark, blades, height, base, spread = 7, curve = 1.2 }) {
  p.clear();
  for (let i = 0; i < blades; i++) {
    const rootX = p.size / 2 + (p.rand() - 0.5) * 2 * spread;
    const lean = (p.rand() - 0.5) * 2 * curve;
    const h = height * (0.6 + p.rand() * 0.6);
    const tone = 0.75 + p.rand() * 0.5;
    for (let k = 0; k < h; k++) {
      const t = k / h;
      const x = Math.round(rootX + lean * t * t * 5);
      const y = Math.round(base - k);
      if (x < 0 || x >= p.size || y < 0 || y >= p.size) continue;
      const c = t > 0.6 ? dark : color;
      p.set(x, y, c[0] * tone, c[1] * tone, c[2] * tone, 255);
      // Widen the lower half so blades are not single-pixel hairlines.
      if (t < 0.5 && x + 1 < p.size) {
        p.set(x + 1, y, c[0] * tone * 0.85, c[1] * tone * 0.85, c[2] * tone * 0.85, 255);
      }
    }
  }
  return p;
}

/** A small flower: green stem, leaves, and a coloured head. */
function flowerTexture(p, petal, petalHi, center) {
  plantTexture(p, { color: [92, 140, 62], dark: [70, 112, 48], blades: 3, height: 16, base: 30, spread: 2, curve: 0.5 });
  const cx = 16;
  const cy = 11;
  const petals = [
    [0, -3], [0, -2], [-3, 0], [-2, 0], [3, 0], [2, 0], [0, 3], [0, 2],
    [-2, -2], [2, -2], [-2, 2], [2, 2],
  ];
  for (const [dx, dy] of petals) {
    const x = cx + dx;
    const y = cy + dy;
    const c = Math.abs(dx) + Math.abs(dy) > 3 ? petal : petalHi;
    p.set(x, y, c[0], c[1], c[2], 255);
    p.set(x + 1, y, c[0] * 0.92, c[1] * 0.92, c[2] * 0.92, 255);
  }
  p.set(cx, cy, center[0], center[1], center[2], 255);
  p.set(cx + 1, cy, center[0], center[1], center[2], 255);
  return p;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

let cached = null;

/**
 * Textures the block registry never asks for, appended after the block layers.
 * The player skin lives here so the avatar and the held-item view model can be
 * drawn from the same array texture as the world, with no second bind.
 */
export const EXTRA_TEXTURES = [
  'skin_face', 'skin_head', 'skin_hair', 'skin_body', 'skin_arm', 'skin_leg',
];

/**
 * Paint every registered block texture into a DataArrayTexture and tell the
 * block registry which layer each texture landed on.
 */
export function buildBlockTextures() {
  if (cached) return cached;

  const names = [...collectTextureNames(), ...EXTRA_TEXTURES];
  const layers = names.length;
  const data = new Uint8Array(TILE * TILE * 4 * layers);
  const tileIndexByName = new Map();
  /** Mean colour of each layer, in linear 0..1, for particles and map colours. */
  const averages = new Float32Array(layers * 3);

  names.forEach((name, layer) => {
    const painter = painters[name];
    const rand = mulberry32(hashString(`texture:${name}`));
    const p = new Painter(rand, TILE);
    if (painter) {
      painter(p);
    } else {
      // Unmistakable magenta so a missing painter is impossible to miss.
      p.fill([255, 0, 220]).bricks([0, 0, 0], 4, 1);
      console.warn(`[atlas] no painter for texture "${name}"`);
    }
    writeTileFlipped(p, data, layer * TILE * TILE * 4);
    tileIndexByName.set(name, layer);
    writeAverage(p, name, averages, layer);
  });

  assignTileIndices(tileIndexByName);

  const texture = new THREE.DataArrayTexture(data, TILE, TILE, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  // Nearest magnification preserves the pixel-art crispness up close; mipmapped
  // minification removes the shimmer that would otherwise crawl across distant
  // terrain as the camera moves.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  cached = { texture, layers, names, tileIndexByName, averages };
  return cached;
}

/**
 * Copy a painted tile into the atlas bottom row first.
 *
 * Painters author top-down, the way every 2D image is written: row 0 is the
 * top of the picture, which is why `bevel` lights row 0 and the torch's flame
 * sits above its stick. A `DataArrayTexture` has `flipY = false`, so its first
 * row of data is `v = 0` — and `v = 0` is the *bottom* edge of every quad the
 * mesher emits. Uploaded as-is, every texture in the game renders vertically
 * mirrored.
 *
 * Flipping here, once, at the only point where painted pixels become GPU data,
 * fixes the world, the held item, the avatar and the block models together.
 * The 2D icon path deliberately does not flip: a canvas shares the painter's
 * top-down convention already.
 */
function writeTileFlipped(painter, data, offset) {
  const size = painter.size;
  const stride = size * 4;
  for (let row = 0; row < size; row++) {
    const from = (size - 1 - row) * stride;
    data.set(painter.px.subarray(from, from + stride), offset + row * stride);
  }
}

/**
 * Mean colour of a painted tile, converted to linear space so it can be used
 * directly by shaders that work in linear (the particle system does).
 *
 * Cutout textures average only their opaque pixels — otherwise a leaf's holes
 * would drag its colour toward black.
 */
function writeAverage(painter, name, out, layer) {
  const cutout = CUTOUT_TEXTURES.has(name);
  let r = 0;
  let g = 0;
  let b = 0;
  let samples = 0;
  for (let i = 0; i < painter.px.length; i += 4) {
    if (cutout && painter.px[i + 3] < 128) continue;
    r += painter.px[i];
    g += painter.px[i + 1];
    b += painter.px[i + 2];
    samples++;
  }
  if (samples === 0) samples = 1;
  const scale = 1 / (samples * 255);
  // sRGB to linear, matching the shader's texture decode.
  out[layer * 3] = srgbToLinear(r * scale);
  out[layer * 3 + 1] = srgbToLinear(g * scale);
  out[layer * 3 + 2] = srgbToLinear(b * scale);
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Average colour of a block, taken from its top face. Used for break particles
 * and the debug map. Returns a linear RGB triple.
 */
export function blockAverageColor(id, out = [1, 1, 1]) {
  const atlas = buildBlockTextures();
  const block = BLOCKS[id];
  const layer = block ? block.tiles[2] : 0;
  if (layer < 0) return out;
  out[0] = atlas.averages[layer * 3];
  out[1] = atlas.averages[layer * 3 + 1];
  out[2] = atlas.averages[layer * 3 + 2];
  return out;
}

/**
 * The block-breaking overlay: progressively denser cracks, drawn on top of the
 * block being mined.
 *
 * Every stage is painted from the same seed, so a crack that appears at stage
 * two is still in exactly the same place at stage seven — the damage looks like
 * it is spreading rather than being redrawn.
 */
export function buildCrackTextures(stages = 8) {
  const textures = [];

  for (let stage = 0; stage < stages; stage++) {
    const rand = mulberry32(hashString('block-cracks'));
    const p = new Painter(rand, TILE);
    p.clear();

    const strokes = Math.round(1 + ((stage + 1) / stages) * 8);
    for (let s = 0; s < strokes; s++) {
      let x = Math.floor(rand() * TILE);
      let y = Math.floor(rand() * TILE);
      const length = 6 + Math.floor(rand() * 18) + stage * 2;
      let dx = rand() < 0.5 ? 1 : -1;
      let dy = rand() < 0.5 ? 1 : -1;

      for (let k = 0; k < length; k++) {
        p.set(x, y, 12, 10, 10, 210);
        // A lighter pixel beside the crack reads as a chipped edge catching
        // light, which is what stops the overlay looking like drawn-on lines.
        p.set((x + 1) % TILE, y, 220, 220, 220, 70);
        if (rand() < 0.42) x = (x + dx + TILE) % TILE;
        if (rand() < 0.42) y = (y + dy + TILE) % TILE;
        if (rand() < 0.12) dx = -dx;
        if (rand() < 0.12) dy = -dy;
      }
    }

    const texture = new THREE.DataTexture(new Uint8Array(p.px), TILE, TILE);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    textures.push(texture);
  }

  return textures;
}

/**
 * Raw painted pixels for one texture, exactly as they go into the atlas —
 * including the alpha channel's dual meaning. The inventory icon renderer needs
 * this rather than a flattened canvas, because it has to apply the tint mask
 * itself to draw a grass block green.
 */
export function paintTexturePixels(name) {
  const rand = mulberry32(hashString(`texture:${name}`));
  const p = new Painter(rand, TILE);
  const painter = painters[name];
  if (painter) painter(p);
  else p.fill([255, 0, 220]);
  return p.px;
}

/**
 * Render one block texture to a standalone canvas. Used for inventory icons and
 * the block picker, which need real 2D images rather than a GPU layer.
 */
export function paintTextureToCanvas(name, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE * scale;
  canvas.height = TILE * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const painter = painters[name];
  const rand = mulberry32(hashString(`texture:${name}`));
  const p = new Painter(rand, TILE);
  if (painter) painter(p);
  else p.fill([255, 0, 220]);

  // Alpha doubles as a tint mask on opaque textures, so force it opaque here.
  const rgba = new Uint8ClampedArray(p.px);
  const isCutout = CUTOUT_TEXTURES.has(name);
  if (!isCutout) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  }

  const image = new ImageData(rgba, TILE, TILE);
  const tmp = document.createElement('canvas');
  tmp.width = TILE;
  tmp.height = TILE;
  tmp.getContext('2d').putImageData(image, 0, 0);
  ctx.drawImage(tmp, 0, 0, TILE * scale, TILE * scale);
  return canvas;
}

/** Textures whose alpha channel is a cutout mask rather than a tint mask. */
export const CUTOUT_TEXTURES = new Set([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'cherry_leaves',
  'grass_blade', 'fern', 'poppy', 'dandelion', 'cornflower', 'dead_bush',
  'sugar_cane', 'torch', 'glass', 'ice',
]);
