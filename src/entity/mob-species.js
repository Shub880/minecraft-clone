/**
 * Animal species: anatomy, colours, behaviour and where each one lives.
 *
 * Every animal is a stack of textured boxes, exactly like the player avatar,
 * but the parts are declared as data here rather than assembled in code. That
 * is what lets the renderer merge every animal in the world into a single
 * mesh: it walks one flat list of boxes per species and never has to know
 * which species it is drawing.
 *
 * Part coordinates are in blocks, measured from the animal's feet, with the
 * animal facing -Z — the same convention the player avatar uses, so a head
 * that looks right on the player looks right here.
 *
 * A part's `pivot` is the point it rotates about, and also where the box sits:
 * the box rises from the pivot, unless `hang` is set, in which case it drops
 * from it. That is the difference between a body resting on its hips and a leg
 * swinging from them.
 *
 * `motion` is the only thing the animator branches on:
 *   'body'  fixed to the torso
 *   'head'  turns and tilts to look at whatever the animal is watching
 *   'legA'  front-left and back-right, swinging together
 *   'legB'  the other diagonal pair, swinging against them
 *   'wing'  flaps about the Z axis, mirrored by `side`
 *
 * A part may also declare `attachTo`, the pivot of the head it rides on, which
 * is what makes a cow's horns turn with its head instead of spinning in place.
 */

import * as B from '../world/blocks.js';
import { BiomeId } from '../world/worldgen/biomes.js';

/** Build the six-face layer list for a box from one or two texture names. */
function skin(all, face = null, top = null) {
  // Face order is +X, -X, +Y, -Y, +Z, -Z, and an animal faces -Z.
  return [all, all, top ?? all, all, all, face ?? all];
}

/**
 * A four-legged body plan, since pigs, cows and sheep differ only in their
 * proportions and their hide.
 *
 * @param {object} options
 * @param {string} options.hide     texture for the torso and head sides
 * @param {string} options.face     texture for the front of the head
 * @param {string} options.leg      texture for the legs
 * @param {number} options.bodyY    height of the underside of the torso
 */
function quadruped({
  hide, face, leg, bodyW, bodyH, bodyL, headSize, headY, headZ, legW, legH, legSpreadX, legSpreadZ,
}) {
  // The torso rests directly on the hips, so its base is the leg length.
  const bodyY = legH;
  const parts = [
    {
      name: 'body',
      motion: 'body',
      size: [bodyW, bodyH, bodyL],
      pivot: [0, bodyY, 0],
      layers: skin(hide),
    },
    {
      name: 'head',
      motion: 'head',
      // Pivoted at the neck, so looking down swings the muzzle rather than
      // sliding the whole head through the shoulders.
      size: [headSize, headSize, headSize],
      pivot: [0, headY, headZ],
      layers: skin(hide, face),
    },
  ];

  const legs = [
    ['legA', -legSpreadX, -legSpreadZ],
    ['legB', legSpreadX, -legSpreadZ],
    ['legB', -legSpreadX, legSpreadZ],
    ['legA', legSpreadX, legSpreadZ],
  ];
  for (const [motion, dx, dz] of legs) {
    parts.push({
      name: 'leg',
      motion,
      size: [legW, legH, legW],
      pivot: [dx, legH, dz],
      // Legs hang from the hip, so the geometry is pushed down below its
      // pivot and a rotation reads as a stride rather than a spin.
      hang: true,
      layers: skin(leg),
    });
  }

  return parts;
}

/** All the animals, keyed by name. */
export const SPECIES = {
  pig: {
    name: 'pig',
    display: 'Pig',
    health: 10,
    width: 0.9,
    height: 0.9,
    eyeHeight: 0.8,
    speed: 1.5,
    panicSpeed: 3.4,
    /** Body colour multiplier; the hide texture carries the detail. */
    tint: [1, 1, 1],
    voice: { freq: 420, q: 1.6, decay: 0.22, gain: 0.3, tone: 210, toneGain: 0.7, sweep: -0.25 },
    hurtVoice: { freq: 520, q: 1.4, decay: 0.26, gain: 0.42, tone: 260, toneGain: 0.8, sweep: 0.4 },
    parts: quadruped({
      hide: 'mob_pig',
      face: 'mob_pig_face',
      leg: 'mob_pig_leg',
      bodyW: 0.55, bodyH: 0.45, bodyL: 0.95,
      headSize: 0.46, headY: 0.4, headZ: -0.52,
      legW: 0.2, legH: 0.42, legSpreadX: 0.17, legSpreadZ: 0.3,
    }),
    spawn: {
      weight: 1,
      group: [2, 4],
      biomes: [BiomeId.PLAINS, BiomeId.FOREST, BiomeId.DENSE_FOREST, BiomeId.CHERRY_GROVE, BiomeId.SAVANNA],
    },
  },

  cow: {
    name: 'cow',
    display: 'Cow',
    health: 10,
    width: 1.0,
    height: 1.25,
    eyeHeight: 1.15,
    speed: 1.3,
    panicSpeed: 2.8,
    tint: [1, 1, 1],
    voice: { freq: 260, q: 1.4, decay: 0.55, gain: 0.34, tone: 120, toneGain: 0.9, sweep: -0.35 },
    hurtVoice: { freq: 320, q: 1.3, decay: 0.4, gain: 0.46, tone: 150, toneGain: 0.9, sweep: 0.3 },
    parts: [
      ...quadruped({
        hide: 'mob_cow',
        face: 'mob_cow_face',
        leg: 'mob_cow_leg',
        bodyW: 0.62, bodyH: 0.52, bodyL: 1.05,
        headSize: 0.5, headY: 0.66, headZ: -0.6,
        legW: 0.24, legH: 0.62, legSpreadX: 0.2, legSpreadZ: 0.34,
      }),
      // Horns ride with the head, so they turn when it does.
      {
        name: 'horn', motion: 'head', size: [0.1, 0.12, 0.1],
        pivot: [-0.26, 1.06, -0.62], attachTo: [0, 0.66, -0.6], layers: skin('mob_cow_horn'),
      },
      {
        name: 'horn', motion: 'head', size: [0.1, 0.12, 0.1],
        pivot: [0.26, 1.06, -0.62], attachTo: [0, 0.66, -0.6], layers: skin('mob_cow_horn'),
      },
    ],
    spawn: {
      weight: 1,
      group: [2, 4],
      biomes: [BiomeId.PLAINS, BiomeId.FOREST, BiomeId.TAIGA, BiomeId.SAVANNA, BiomeId.CHERRY_GROVE],
    },
  },

  sheep: {
    name: 'sheep',
    display: 'Sheep',
    health: 8,
    width: 0.9,
    height: 1.2,
    eyeHeight: 1.1,
    speed: 1.35,
    panicSpeed: 3.0,
    tint: [1, 1, 1],
    /** Killing one yields wool in whatever colour it happens to be. */
    fleeceColours: [
      { tint: [0.96, 0.96, 0.95], block: B.WHITE_WOOL, weight: 0.72 },
      { tint: [0.62, 0.63, 0.65], block: B.LIGHT_GRAY_WOOL, weight: 0.09 },
      { tint: [0.18, 0.19, 0.2], block: B.BLACK_WOOL, weight: 0.06 },
      { tint: [0.48, 0.34, 0.22], block: B.BROWN_WOOL, weight: 0.08 },
      { tint: [0.94, 0.66, 0.76], block: B.PINK_WOOL, weight: 0.05 },
    ],
    voice: { freq: 700, q: 1.8, decay: 0.34, gain: 0.28, tone: 340, toneGain: 0.7, sweep: -0.3 },
    hurtVoice: { freq: 820, q: 1.5, decay: 0.3, gain: 0.4, tone: 400, toneGain: 0.8, sweep: 0.35 },
    parts: [
      ...quadruped({
        hide: 'mob_sheep_wool',
        face: 'mob_sheep_face',
        leg: 'mob_sheep_leg',
        bodyW: 0.58, bodyH: 0.5, bodyL: 0.92,
        headSize: 0.42, headY: 0.66, headZ: -0.56,
        legW: 0.19, legH: 0.6, legSpreadX: 0.18, legSpreadZ: 0.3,
      }),
      // A second, slightly larger torso box is the fleece. It is what makes a
      // sheep read as a sheep rather than a small pale cow.
      {
        name: 'fleece', motion: 'body', size: [0.7, 0.6, 1.02],
        pivot: [0, 0.55, 0.02], layers: skin('mob_sheep_wool'), fleece: true,
      },
    ],
    spawn: {
      weight: 1,
      group: [3, 5],
      biomes: [BiomeId.PLAINS, BiomeId.FOREST, BiomeId.TAIGA, BiomeId.SNOWY_TUNDRA, BiomeId.CHERRY_GROVE],
    },
  },

  chicken: {
    name: 'chicken',
    display: 'Chicken',
    health: 4,
    width: 0.45,
    height: 0.7,
    eyeHeight: 0.6,
    speed: 1.1,
    panicSpeed: 2.6,
    tint: [1, 1, 1],
    /** Chickens flap and fall slowly rather than dropping like a stone. */
    glide: 0.35,
    voice: { freq: 1500, q: 2.6, decay: 0.14, gain: 0.22, tone: 900, toneGain: 0.6, sweep: 0.5 },
    hurtVoice: { freq: 1800, q: 2.2, decay: 0.18, gain: 0.34, tone: 1100, toneGain: 0.7, sweep: 0.6 },
    parts: [
      {
        name: 'body', motion: 'body', size: [0.32, 0.36, 0.42],
        pivot: [0, 0.26, 0], layers: skin('mob_chicken'),
      },
      {
        name: 'head', motion: 'head', size: [0.24, 0.24, 0.22],
        pivot: [0, 0.5, -0.16], layers: skin('mob_chicken', 'mob_chicken_face'),
      },
      {
        name: 'wing', motion: 'wing', side: -1, size: [0.06, 0.26, 0.34],
        pivot: [-0.18, 0.58, 0.02], layers: skin('mob_chicken'), hang: true,
      },
      {
        name: 'wing', motion: 'wing', side: 1, size: [0.06, 0.26, 0.34],
        pivot: [0.18, 0.58, 0.02], layers: skin('mob_chicken'), hang: true,
      },
      {
        name: 'leg', motion: 'legA', size: [0.08, 0.26, 0.08],
        pivot: [-0.09, 0.26, 0.02], layers: skin('mob_chicken_foot'), hang: true,
      },
      {
        name: 'leg', motion: 'legB', size: [0.08, 0.26, 0.08],
        pivot: [0.09, 0.26, 0.02], layers: skin('mob_chicken_foot'), hang: true,
      },
    ],
    spawn: {
      weight: 0.8,
      group: [2, 4],
      biomes: [BiomeId.PLAINS, BiomeId.FOREST, BiomeId.SWAMP, BiomeId.CHERRY_GROVE, BiomeId.SAVANNA],
    },
  },
};

export const SPECIES_NAMES = Object.keys(SPECIES);

/** Highest part count of any species, so the renderer can size its buffers. */
export const MAX_PARTS = Math.max(...SPECIES_NAMES.map((name) => SPECIES[name].parts.length));

/**
 * Pick a species that can live in a biome, weighted, or null if none can.
 * @param {number} biome
 * @param {() => number} rand
 */
export function speciesForBiome(biome, rand) {
  let total = 0;
  const candidates = [];
  for (const name of SPECIES_NAMES) {
    const species = SPECIES[name];
    if (!species.spawn.biomes.includes(biome)) continue;
    candidates.push(species);
    total += species.spawn.weight;
  }
  if (candidates.length === 0) return null;

  let roll = rand() * total;
  for (const species of candidates) {
    roll -= species.spawn.weight;
    if (roll <= 0) return species;
  }
  return candidates[candidates.length - 1];
}

/** Choose a sheep's fleece, weighted the way Minecraft's flocks are. */
export function pickFleece(rand) {
  const colours = SPECIES.sheep.fleeceColours;
  let roll = rand();
  for (const colour of colours) {
    roll -= colour.weight;
    if (roll <= 0) return colour;
  }
  return colours[0];
}
