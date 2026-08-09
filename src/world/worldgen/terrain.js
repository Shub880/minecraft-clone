/**
 * Terrain generation.
 *
 * Height comes from a stack of independent noise fields rather than one
 * heightmap, which is what produces terrain with intent: continents decide
 * where land is at all, erosion decides whether that land is flat or dramatic,
 * and a ridged field lays mountain ranges along it.
 *
 * Everything is a pure function of (seed, world position). Nothing depends on
 * the order chunks are generated in, so the same seed always yields the same
 * world and features never get sliced at a chunk boundary.
 */

import { Noise, spline, smoothstep, clamp, lerp } from './noise.js';
import { selectBiome, BiomeId, TreeType, buildBiomeTables, getBiome } from './biomes.js';
import { placeStructures } from './structures.js';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, PADDED_SIZE, TINT_STRIDE } from '../constants.js';
import { rngAt2, hash2 } from '../../core/rng.js';
import * as B from '../blocks.js';

/** Raw continentalness -> base height. The flat run near 0 is the coastline. */
const CONTINENT_SPLINE = [
  [-1.00, 18], [-0.55, 30], [-0.30, 46], [-0.12, 57], [-0.02, 61],
  [0.06, 65], [0.20, 71], [0.45, 82], [0.70, 96], [1.00, 112],
];

/** Erosion -> how much the ridged mountain field is allowed to contribute. */
const EROSION_SPLINE = [
  [-1.00, 1.00], [-0.55, 0.82], [-0.20, 0.48],
  [0.15, 0.22], [0.50, 0.10], [1.00, 0.05],
];

const PEAK_AMPLITUDE = 70;

/** Above this height alpine biomes get a snow cap. */
const SNOW_LINE = 122;

/**
 * Highest tree density of any biome, used purely as an early-rejection bound
 * so most columns never touch the noise functions. Must stay >= the largest
 * `treeDensity` in the biome table.
 */
const MAX_TREE_DENSITY = 0.12;

export const WorldType = {
  CONTINENTS: 'continents',
  ISLANDS: 'islands',
  AMPLIFIED: 'amplified',
  SUPERFLAT: 'superflat',
  FLOATING: 'floating',
};

export class TerrainGenerator {
  constructor(seed, options = {}) {
    this.seed = seed >>> 0;
    this.worldType = options.worldType ?? WorldType.CONTINENTS;
    this.caveDensity = options.caveDensity ?? 1;
    this.treeDensity = options.treeDensity ?? 1;
    /** Multiplier on every structure's spawn chance. 0 switches them off. */
    this.structureDensity = options.structureDensity ?? 1;

    // Each field gets its own permutation table so they are uncorrelated.
    this.continent = new Noise(seed ^ 0x1a2b3c4d);
    this.erosion = new Noise(seed ^ 0x2b3c4d5e);
    this.peaks = new Noise(seed ^ 0x3c4d5e6f);
    this.temperature = new Noise(seed ^ 0x4d5e6f70);
    this.humidity = new Noise(seed ^ 0x5e6f7081);
    this.rivers = new Noise(seed ^ 0x6f708192);
    this.detail = new Noise(seed ^ 0x708192a3);
    this.caveA = new Noise(seed ^ 0x8192a3b4);
    this.caveB = new Noise(seed ^ 0x92a3b4c5);
    this.caveC = new Noise(seed ^ 0xa3b4c5d6);

    this.biomeTables = buildBiomeTables();

    // Scratch buffers for the padded column data of the chunk being built.
    this.columnHeight = new Int16Array(PADDED_SIZE * PADDED_SIZE);
    this.columnBiome = new Uint8Array(PADDED_SIZE * PADDED_SIZE);
    this.tintAccumulator = new Float32Array(TINT_STRIDE);
  }

  // -------------------------------------------------------------------------
  // Column sampling
  // -------------------------------------------------------------------------

  /** Continentalness in -1..1. Islands squash it so land breaks into pieces. */
  continentalnessAt(x, z) {
    const raw = this.continent.fbm2(x * 0.00055, z * 0.00055, 4);
    if (this.worldType === WorldType.ISLANDS) {
      // Sharpen around zero so landmasses shrink and separate.
      return clamp(raw * 2.4 - 0.35, -1, 1);
    }
    return raw;
  }

  /** Terrain surface height at a world column. */
  heightAt(x, z) {
    if (this.worldType === WorldType.SUPERFLAT) return SEA_LEVEL + 2;

    const c = this.continentalnessAt(x, z);
    const e = this.erosion.fbm2(x * 0.0011, z * 0.0011, 4);
    const p = this.peaks.ridged2(x * 0.0026, z * 0.0026, 4);

    const base = spline(CONTINENT_SPLINE, c);
    let amplitude = spline(EROSION_SPLINE, e);
    if (this.worldType === WorldType.AMPLIFIED) amplitude *= 2.1;

    // Ridged noise averages well above zero, so subtract a floor to keep
    // valleys at the base height instead of lifting the whole world.
    let height = base + (p - 0.32) * amplitude * PEAK_AMPLITUDE;

    // Fine surface relief, scaled down on flat terrain so plains stay plains.
    height += this.detail.fbm2(x * 0.021, z * 0.021, 3) * 2.4 * (0.35 + amplitude);

    height = this.carveRiver(x, z, height);

    return Math.round(clamp(height, 4, WORLD_HEIGHT - 40));
  }

  /**
   * Rivers follow the zero crossing of a low frequency field, so they meander
   * over long distances instead of looking like noise artefacts.
   */
  carveRiver(x, z, height) {
    if (height <= SEA_LEVEL - 4) return height;
    const r = this.rivers.fbm2(x * 0.00085, z * 0.00085, 2);
    const riverness = 1 - smoothstep(0.0, 0.055, Math.abs(r));
    if (riverness <= 0) return height;
    const bed = SEA_LEVEL - 2;
    // Fade the carve out as terrain climbs, so rivers do not slice mountains.
    const reach = 1 - smoothstep(SEA_LEVEL + 6, SEA_LEVEL + 34, height);
    return lerp(height, Math.min(height, bed), riverness * 0.94 * reach);
  }

  /** Biome for a world column, given its already-computed height. */
  biomeAt(x, z, height) {
    const t = this.temperature.fbm2(x * 0.00072, z * 0.00072, 3);
    const h = this.humidity.fbm2(x * 0.00095, z * 0.00095, 3);
    const c = this.continentalnessAt(x, z);
    const r = this.rivers.fbm2(x * 0.00085, z * 0.00085, 2);
    const riverness = 1 - smoothstep(0.0, 0.055, Math.abs(r));
    return selectBiome(t, h, height, c, riverness, SEA_LEVEL);
  }

  // -------------------------------------------------------------------------
  // Caves
  // -------------------------------------------------------------------------

  /**
   * Two cave systems layered together: wide open chambers from 3D fbm, and
   * long winding tunnels where two ridged fields both peak at once.
   */
  isCave(x, y, z) {
    if (y < 5 || y > 128) return false;

    // Taper the carve near the surface so caves rarely open as gaping holes.
    const surfaceFade = smoothstep(0, 10, y) * (1 - smoothstep(96, 128, y));
    const threshold = 0.845 - 0.03 * this.caveDensity * surfaceFade;

    const t1 = this.caveA.ridged3(x * 0.0135, y * 0.021, z * 0.0135, 2);
    if (t1 > threshold) {
      const t2 = this.caveB.ridged3(x * 0.0135, y * 0.021, z * 0.0135, 2);
      if (t2 > threshold) return true;
    }

    const chamber = this.caveC.fbm3(x * 0.0125, y * 0.026, z * 0.0125, 3);
    if (chamber > 0.615 - 0.05 * (this.caveDensity - 1)) return true;

    return false;
  }

  // -------------------------------------------------------------------------
  // Chunk generation
  // -------------------------------------------------------------------------

  /** Fill a chunk's blocks, heightmap, biomes and tints. */
  generateChunk(chunk) {
    const originX = chunk.cx * CHUNK_SIZE;
    const originZ = chunk.cz * CHUNK_SIZE;

    // Sample one block beyond the chunk so tint blending has real neighbours.
    for (let pz = 0; pz < PADDED_SIZE; pz++) {
      for (let px = 0; px < PADDED_SIZE; px++) {
        const wx = originX + px - 1;
        const wz = originZ + pz - 1;
        const height = this.heightAt(wx, wz);
        const i = pz * PADDED_SIZE + px;
        this.columnHeight[i] = height;
        this.columnBiome[i] = this.biomeAt(wx, wz, height);
      }
    }

    this.fillTerrain(chunk, originX, originZ);
    this.writeTints(chunk);
    this.placeOres(chunk);
    this.placeTrees(chunk, originX, originZ);
    this.placePlants(chunk, originX, originZ);
    // Last, so a building clears the forest it landed in rather than growing
    // through it. Superflat is left alone: there is no terrain to sit on.
    if (this.worldType !== WorldType.SUPERFLAT) {
      placeStructures(this, chunk, this.makePlacer(chunk, originX, originZ));
    }
  }

  fillTerrain(chunk, originX, originZ) {
    const tables = this.biomeTables;
    const superflat = this.worldType === WorldType.SUPERFLAT;

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = originX + x;
        const wz = originZ + z;
        const padded = (z + 1) * PADDED_SIZE + (x + 1);
        const height = this.columnHeight[padded];
        const biome = this.columnBiome[padded];

        chunk.biomes[z * CHUNK_SIZE + x] = biome;

        const surface = tables.surface[biome];
        const subsurface = tables.subsurface[biome];
        const underwater = tables.underwater[biome];
        const filler = tables.filler[biome];
        const surfaceDepth = tables.surfaceDepth[biome];
        const subsurfaceDepth = tables.subsurfaceDepth[biome];
        const submerged = height < SEA_LEVEL;

        const top = Math.max(height, SEA_LEVEL);
        for (let y = 0; y <= top; y++) {
          let id = B.AIR;

          if (y === 0) {
            id = B.BEDROCK;
          } else if (y < 4 && !superflat) {
            // Ragged bedrock floor rather than a flat slab.
            id = hash2(wx * 31 + y, wz * 17, this.seed) % 5 > y ? B.BEDROCK : filler;
          } else if (y <= height) {
            const depth = height - y;
            if (!superflat && this.isCave(wx, y, wz)) {
              // Flood the deepest caves with lava; leave the rest open.
              id = y < 11 ? B.LAVA : B.AIR;
            } else if (depth < surfaceDepth) {
              id = submerged ? underwater : surface;
            } else if (depth < surfaceDepth + subsurfaceDepth) {
              id = submerged && depth < surfaceDepth + 1 ? underwater : subsurface;
            } else {
              id = filler;
            }
          } else if (y <= SEA_LEVEL) {
            id = B.WATER;
          }

          if (id !== B.AIR) chunk.setBlockRaw(x, y, z, id);
        }

        // Snow caps on peaks, thickening with altitude.
        if (tables.snow[biome] && height > SEA_LEVEL && height >= SNOW_LINE - 40) {
          const above = height >= SNOW_LINE ? 1 : 0;
          if (above || biome === BiomeId.SNOWY_TUNDRA) {
            chunk.setBlockRaw(x, height, z, B.SNOW_BLOCK);
          }
        }
      }
    }
  }

  /**
   * Per-column tint, box-blurred across the 3x3 neighbourhood of biomes.
   * Without the blur, biome borders show as a hard colour edge across the
   * ground; with it, forest fades into plains over a few blocks.
   */
  writeTints(chunk) {
    const tables = this.biomeTables;
    const accumulator = this.tintAccumulator;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        accumulator.fill(0);
        let samples = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const biome = this.columnBiome[(z + 1 + dz) * PADDED_SIZE + (x + 1 + dx)];
            const from = biome * TINT_STRIDE;
            for (let k = 0; k < TINT_STRIDE; k++) accumulator[k] += tables.tint[from + k];
            samples++;
          }
        }
        const out = (z * CHUNK_SIZE + x) * TINT_STRIDE;
        for (let k = 0; k < TINT_STRIDE; k++) {
          chunk.tint[out + k] = Math.round(accumulator[k] / samples);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ores
  // -------------------------------------------------------------------------

  /** Ore kinds with the depth band they appear in and how common they are. */
  static ORES = [
    { id: B.COAL_ORE, minY: 8, maxY: 118, veins: 15, size: 9, salt: 1 },
    { id: B.IRON_ORE, minY: 6, maxY: 88, veins: 11, size: 7, salt: 2 },
    { id: B.GOLD_ORE, minY: 4, maxY: 40, veins: 3, size: 6, salt: 3 },
    { id: B.REDSTONE_ORE, minY: 4, maxY: 26, veins: 5, size: 7, salt: 4 },
    { id: B.LAPIS_ORE, minY: 4, maxY: 34, veins: 3, size: 6, salt: 5 },
    { id: B.DIAMOND_ORE, minY: 3, maxY: 18, veins: 2, size: 5, salt: 6 },
  ];

  placeOres(chunk) {
    for (const ore of TerrainGenerator.ORES) {
      const rand = rngAt2(chunk.cx, chunk.cz, this.seed, ore.salt);
      for (let v = 0; v < ore.veins; v++) {
        const x = Math.floor(rand() * CHUNK_SIZE);
        const z = Math.floor(rand() * CHUNK_SIZE);
        const y = ore.minY + Math.floor(rand() * (ore.maxY - ore.minY));
        this.growVein(chunk, x, y, z, ore.id, ore.size, rand);
      }
    }
  }

  /** Random walk from a vein origin, replacing stone only. */
  growVein(chunk, x, y, z, id, size, rand) {
    let cx = x;
    let cy = y;
    let cz = z;
    for (let i = 0; i < size; i++) {
      if (cx >= 0 && cx < CHUNK_SIZE && cz >= 0 && cz < CHUNK_SIZE && cy > 1 && cy < WORLD_HEIGHT) {
        if (chunk.getBlock(cx, cy, cz) === B.STONE) {
          chunk.setBlockRaw(cx, cy, cz, id);
        }
      }
      cx += Math.floor(rand() * 3) - 1;
      cy += Math.floor(rand() * 3) - 1;
      cz += Math.floor(rand() * 3) - 1;
    }
  }

  // -------------------------------------------------------------------------
  // Surface features
  // -------------------------------------------------------------------------

  /**
   * Build a writer that only lets blocks through if they land inside `target`.
   */
  makePlacer(target, originX, originZ) {
    return (wx, wy, wz, id, onlyAir = true) => {
      const lx = wx - originX;
      const lz = wz - originZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      if (wy < 0 || wy >= WORLD_HEIGHT) return;
      if (onlyAir) {
        const existing = target.getBlock(lx, wy, lz);
        if (existing !== B.AIR && existing !== B.WATER) return;
      }
      target.setBlockRaw(lx, wy, lz, id);
    };
  }

  /**
   * Trees, generated for the 3x3 block of chunks around this one and clipped
   * to its bounds.
   *
   * The redundant work buys a lot: a tree rooted in a neighbouring chunk still
   * grows its canopy into this one, with no deferred-feature queue, no
   * revisiting already-meshed chunks, and no dependence on the order chunks
   * happen to be generated in. Each tree is seeded from its own world position,
   * so both halves of a border-straddling tree agree exactly.
   */
  placeTrees(target, originX, originZ) {
    const place = this.makePlacer(target, originX, originZ);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = target.cx + dx;
        const cz = target.cz + dz;
        const rand = rngAt2(cx, cz, this.seed, 77);
        const baseX = cx * CHUNK_SIZE;
        const baseZ = cz * CHUNK_SIZE;
        const isSelf = dx === 0 && dz === 0;

        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            // One roll per column keeps the stream aligned across chunks.
            const roll = rand();
            // Reject on the densest biome's rate before touching the noise
            // functions, which skips the height and biome lookup for the ~90%
            // of columns that could never hold a tree.
            if (roll >= MAX_TREE_DENSITY * this.treeDensity) continue;

            const wx = baseX + x;
            const wz = baseZ + z;

            let height;
            let biomeId;
            if (isSelf) {
              const padded = (z + 1) * PADDED_SIZE + (x + 1);
              height = this.columnHeight[padded];
              biomeId = this.columnBiome[padded];
            } else {
              height = this.heightAt(wx, wz);
              biomeId = this.biomeAt(wx, wz, height);
            }
            if (height <= SEA_LEVEL) continue;

            const biome = getBiome(biomeId);
            if (roll >= biome.treeDensity * this.treeDensity) continue;

            const treeRand = rngAt2(wx, wz, this.seed, 91);
            let type = biome.tree;
            if (biome.secondaryTree !== TreeType.NONE && treeRand() < biome.secondaryChance) {
              type = biome.secondaryTree;
            }
            this.buildTree(type, wx, height + 1, wz, place, treeRand);
          }
        }
      }
    }
  }

  /**
   * Grass, ferns and flowers. Unlike trees these are a single block tall and
   * never cross a chunk border, so only the target chunk needs visiting.
   */
  placePlants(target, originX, originZ) {
    const place = this.makePlacer(target, originX, originZ);
    const rand = rngAt2(target.cx, target.cz, this.seed, 78);

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const roll = rand();
        const padded = (z + 1) * PADDED_SIZE + (x + 1);
        const height = this.columnHeight[padded];
        if (height <= SEA_LEVEL) continue;

        const biome = getBiome(this.columnBiome[padded]);
        let cumulative = 0;
        for (const plant of biome.plants) {
          cumulative += plant.density;
          if (roll >= cumulative) continue;
          const ground = target.getBlock(x, height, z);
          if (ground === B.GRASS_BLOCK || ground === B.SAND || ground === B.PODZOL
            || ground === B.MUD || ground === B.MOSS_BLOCK) {
            place(originX + x, height + 1, originZ + z, plant.id);
          }
          break;
        }
      }
    }
  }

  /** Dispatch to the right tree shape. */
  buildTree(type, x, y, z, place, rand) {
    switch (type) {
      case TreeType.OAK:
        return this.buildRoundTree(x, y, z, place, rand, {
          log: B.OAK_LOG, leaves: B.OAK_LEAVES, minHeight: 4, maxHeight: 6, radius: 2,
        });
      case TreeType.SWAMP_OAK:
        return this.buildRoundTree(x, y, z, place, rand, {
          log: B.OAK_LOG, leaves: B.OAK_LEAVES, minHeight: 5, maxHeight: 7, radius: 3, flatten: 0.6,
        });
      case TreeType.BIRCH:
        return this.buildRoundTree(x, y, z, place, rand, {
          log: B.BIRCH_LOG, leaves: B.BIRCH_LEAVES, minHeight: 5, maxHeight: 7, radius: 2,
        });
      case TreeType.CHERRY:
        return this.buildRoundTree(x, y, z, place, rand, {
          log: B.CHERRY_LOG, leaves: B.CHERRY_LEAVES, minHeight: 5, maxHeight: 7, radius: 3, flatten: 0.7,
        });
      case TreeType.DARK_OAK:
        return this.buildThickTree(x, y, z, place, rand, {
          log: B.OAK_LOG, leaves: B.OAK_LEAVES, minHeight: 6, maxHeight: 8, radius: 3,
        });
      case TreeType.SPRUCE:
        return this.buildConifer(x, y, z, place, rand, {
          log: B.SPRUCE_LOG, leaves: B.SPRUCE_LEAVES, minHeight: 7, maxHeight: 11,
        });
      case TreeType.LARGE_SPRUCE:
        return this.buildConifer(x, y, z, place, rand, {
          log: B.SPRUCE_LOG, leaves: B.SPRUCE_LEAVES, minHeight: 12, maxHeight: 17, wide: true,
        });
      case TreeType.ACACIA:
        return this.buildAcacia(x, y, z, place, rand);
      case TreeType.CACTUS:
        return this.buildCactus(x, y, z, place, rand);
      default:
        return undefined;
    }
  }

  buildRoundTree(x, y, z, place, rand, options) {
    const { log, leaves, minHeight, maxHeight, radius, flatten = 1 } = options;
    const height = minHeight + Math.floor(rand() * (maxHeight - minHeight + 1));

    for (let i = 0; i < height; i++) place(x, y + i, z, log, false);

    const centerY = y + height - 1;
    const rSquared = radius * radius + 0.4;
    for (let dy = -1; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const stretched = dy / flatten;
          const d = dx * dx + stretched * stretched + dz * dz;
          if (d > rSquared) continue;
          // Ragged edge so canopies are not obvious spheres.
          if (d > rSquared - 2.2 && rand() < 0.45) continue;
          place(x + dx, centerY + dy, z + dz, leaves);
        }
      }
    }
  }

  buildThickTree(x, y, z, place, rand, options) {
    const { log, leaves, minHeight, maxHeight, radius } = options;
    const height = minHeight + Math.floor(rand() * (maxHeight - minHeight + 1));

    // 2x2 trunk.
    for (let i = 0; i < height; i++) {
      place(x, y + i, z, log, false);
      place(x + 1, y + i, z, log, false);
      place(x, y + i, z + 1, log, false);
      place(x + 1, y + i, z + 1, log, false);
    }

    const centerY = y + height;
    for (let dy = -2; dy <= 1; dy++) {
      const layerRadius = dy >= 1 ? radius - 2 : radius;
      for (let dz = -layerRadius; dz <= layerRadius + 1; dz++) {
        for (let dx = -layerRadius; dx <= layerRadius + 1; dx++) {
          const d = dx * dx + dz * dz;
          if (d > layerRadius * layerRadius + 2) continue;
          if (d > layerRadius * layerRadius - 1 && rand() < 0.4) continue;
          place(x + dx, centerY + dy, z + dz, leaves);
        }
      }
    }
  }

  buildConifer(x, y, z, place, rand, options) {
    const { log, leaves, minHeight, maxHeight, wide = false } = options;
    const height = minHeight + Math.floor(rand() * (maxHeight - minHeight + 1));

    for (let i = 0; i < height; i++) {
      place(x, y + i, z, log, false);
      if (wide) {
        place(x + 1, y + i, z, log, false);
        place(x, y + i, z + 1, log, false);
        place(x + 1, y + i, z + 1, log, false);
      }
    }

    // Stacked rings that shrink toward the top, with a bare lower trunk.
    const start = Math.floor(height * 0.35);
    for (let i = start; i < height; i++) {
      const t = (i - start) / (height - start);
      let radius = Math.round((1 - t) * (wide ? 3.4 : 2.4));
      // Alternating radius gives conifers their layered silhouette.
      if (i % 2 === 0) radius = Math.max(0, radius - 1);
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dz * dz > radius * radius + 0.6) continue;
          place(x + dx, y + i, z + dz, leaves);
        }
      }
    }
    place(x, y + height, z, leaves);
    place(x, y + height + 1, z, leaves);
  }

  buildAcacia(x, y, z, place, rand) {
    const height = 5 + Math.floor(rand() * 3);
    const leanX = rand() < 0.5 ? 1 : -1;
    const leanZ = rand() < 0.5 ? 1 : -1;

    let tx = x;
    let tz = z;
    for (let i = 0; i < height; i++) {
      place(tx, y + i, tz, B.OAK_LOG, false);
      // Bend partway up, which is what gives acacias their distinctive shape.
      if (i > height / 2 && i % 2 === 0) {
        tx += leanX;
        tz += rand() < 0.5 ? leanZ : 0;
        place(tx, y + i, tz, B.OAK_LOG, false);
      }
    }

    // Wide flat canopy.
    const top = y + height;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = dx * dx + dz * dz;
        if (d > 10) continue;
        place(tx + dx, top, tz + dz, B.OAK_LEAVES);
        if (d <= 4) place(tx + dx, top + 1, tz + dz, B.OAK_LEAVES);
      }
    }
  }

  buildCactus(x, y, z, place, rand) {
    const height = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < height; i++) place(x, y + i, z, B.CACTUS, false);
  }
}
