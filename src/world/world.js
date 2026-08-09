/**
 * Chunk streaming and the render-side chunk manager.
 *
 * Owns the loaded chunk map, decides what to generate next, runs lighting and
 * meshing under a per-frame time budget, and keeps the Three.js scene in sync.
 *
 * The budget is the important part: work is sliced so a frame never stalls,
 * even when the player flies fast into ungenerated terrain. Anything that
 * cannot finish this frame simply resumes next frame.
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE,
  SECTION_COUNT,
  SECTION_HEIGHT,
  WORLD_HEIGHT,
  PADDED_SIZE,
  paddedIndex,
  chunkKey,
  toChunkCoord,
  toLocalCoord,
} from './constants.js';
import { Chunk, ChunkState } from './chunk.js';
import { AIR, buildBlockTables, Bucket } from './blocks.js';
import { computeChunkLight } from './lighting.js';
import { LightPropagator } from './light-update.js';
import { meshSection, TINT_STRIDE } from '../render/mesher.js';
import { buildGeometry } from '../render/materials.js';
import { TerrainGenerator } from './worldgen/terrain.js';

const PADDED_VOLUME = PADDED_SIZE * PADDED_SIZE * PADDED_SIZE;
const PADDED_COLUMNS = PADDED_SIZE * PADDED_SIZE;

export class World {
  /**
   * @param {object} options
   * @param {number} options.seed
   * @param {THREE.Scene} options.scene
   * @param {import('../render/materials.js').WorldMaterials} options.materials
   */
  constructor({
    seed, scene, materials, worldType, caveDensity, treeDensity, structureDensity, savedEdits,
  }) {
    this.seed = seed >>> 0;
    this.scene = scene;
    this.materials = materials;

    this.tables = buildBlockTables();
    this.generator = new TerrainGenerator(this.seed, {
      worldType, caveDensity, treeDensity, structureDensity,
    });
    this.light = new LightPropagator(this);

    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();

    /**
     * Player edits loaded from disk, keyed like `chunks`. Consulted when a
     * chunk is generated so a rebuilt chunk comes back with its changes.
     * @type {Map<string, {cx:number, cz:number, keys:Uint32Array, values:Uint16Array}>}
     */
    this.savedEdits = savedEdits ?? new Map();
    /** Chunk keys whose edit list has changed since the last save. */
    this.dirtyEdits = new Set();
    /** Serialised edit lists waiting to be written out. */
    this.pendingWrites = new Map();

    /** Chunks awaiting generation, nearest first. */
    this.pending = [];
    this.pendingDirty = true;

    /** Scratch list for distance-ordered meshing; reused every frame. */
    this.meshCandidates = [];

    this.renderDistance = 10;
    this.centerX = 0;
    this.centerZ = 0;

    // Reused scratch buffers; meshing one section at a time means a single set
    // is enough and nothing is allocated per chunk.
    this.scratchBlocks = new Uint16Array(PADDED_VOLUME);
    this.scratchLight = new Uint8Array(PADDED_VOLUME);
    this.scratchTint = new Uint8Array(PADDED_COLUMNS * TINT_STRIDE);
    this.neighborCache = new Array(9).fill(null);

    this.group = new THREE.Group();
    this.group.name = 'world';
    this.scene.add(this.group);

    this.stats = {
      chunksLoaded: 0,
      pending: 0,
      meshed: 0,
      triangles: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Chunk access
  // -------------------------------------------------------------------------

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz)) ?? null;
  }

  /** Read a block in world coordinates. Unloaded chunks read as air. */
  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return AIR;
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk) return AIR;
    return chunk.getBlock(toLocalCoord(wx), wy, toLocalCoord(wz));
  }

  getSkyLight(wx, wy, wz) {
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk) return 15;
    return chunk.getSkyLight(toLocalCoord(wx), wy, toLocalCoord(wz));
  }

  getBlockLight(wx, wy, wz) {
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk) return 0;
    return chunk.getBlockLight(toLocalCoord(wx), wy, toLocalCoord(wz));
  }

  /**
   * Per-column biome tint as a 0..1 multiplier.
   * @param {number} kind  1 grass, 2 foliage, 3 water — matching `Tint`
   */
  getTint(wx, wz, kind, out = [1, 1, 1]) {
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk) return null;
    const column = (toLocalCoord(wz) * CHUNK_SIZE + toLocalCoord(wx)) * TINT_STRIDE;
    const offset = kind === 1 ? 0 : kind === 2 ? 3 : 6;
    out[0] = chunk.tint[column + offset] / 255;
    out[1] = chunk.tint[column + offset + 1] / 255;
    out[2] = chunk.tint[column + offset + 2] / 255;
    return out;
  }

  /**
   * Write a block and queue everything the change invalidates.
   *
   * Geometry dirtying is local — the edited section, plus a neighbour when the
   * edit sits on a boundary. Lighting is handled by the incremental propagator,
   * which marks whatever *it* touched, so a torch lighting up an adjacent chunk
   * re-meshes that chunk and nothing else.
   */
  setBlock(wx, wy, wz, id, { recordEdit = true } = {}) {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const cx = toChunkCoord(wx);
    const cz = toChunkCoord(wz);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return false;

    const lx = toLocalCoord(wx);
    const lz = toLocalCoord(wz);
    const previous = chunk.getBlock(lx, wy, lz);
    if (!chunk.setBlock(lx, wy, lz, id)) return false;

    if (recordEdit) {
      chunk.recordEdit(lx, wy, lz, id);
      this.dirtyEdits.add(chunkKey(cx, cz));
    }

    chunk.updateSkySection();
    chunk.markDirtyAround(wy);

    if (lx === 0) this.markSeamDirty(cx - 1, cz, wy);
    else if (lx === CHUNK_SIZE - 1) this.markSeamDirty(cx + 1, cz, wy);
    if (lz === 0) this.markSeamDirty(cx, cz - 1, wy);
    else if (lz === CHUNK_SIZE - 1) this.markSeamDirty(cx, cz + 1, wy);

    this.light.applyBlockChange(wx, wy, wz, previous, id);
    return true;
  }

  /** Mark a neighbouring chunk's geometry stale without relighting it. */
  markSeamDirty(cx, cz, wy) {
    const chunk = this.getChunk(cx, cz);
    if (chunk) chunk.markDirtyAround(wy);
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  setRenderDistance(chunks) {
    this.renderDistance = chunks;
    this.pendingDirty = true;
    this.materials.setRenderDistance(chunks);
  }

  /**
   * Advance streaming by up to `budgetMs` of work.
   * Returns true while there is still work owed for the current view.
   */
  update(cameraPosition, budgetMs = 6) {
    const cx = toChunkCoord(cameraPosition.x);
    const cz = toChunkCoord(cameraPosition.z);
    if (cx !== this.centerX || cz !== this.centerZ || this.pendingDirty) {
      this.centerX = cx;
      this.centerZ = cz;
      this.pendingDirty = false;
      this.rebuildPending();
      this.unloadDistant();
    }

    const deadline = performance.now() + budgetMs;
    let worked = false;

    // Generation first: meshing a chunk needs its neighbours to exist.
    while (this.pending.length > 0 && performance.now() < deadline) {
      const { cx: gx, cz: gz } = this.pending.pop();
      const key = chunkKey(gx, gz);
      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = new Chunk(gx, gz);
        this.chunks.set(key, chunk);
      }
      if (chunk.state >= ChunkState.GENERATED) continue;
      this.generateChunk(chunk);
      worked = true;
    }

    // Then meshing, for chunks whose neighbourhood is complete. Nearest first,
    // so the world fills in outward from the player rather than in map order —
    // with a budget this tight, the ordering is what the player perceives as
    // load speed.
    const candidates = this.meshCandidates;
    candidates.length = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.dirtySections.size === 0) continue;
      const dx = chunk.cx - this.centerX;
      const dz = chunk.cz - this.centerZ;
      candidates.push({ chunk, distance: dx * dx + dz * dz });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    for (const candidate of candidates) {
      if (performance.now() >= deadline) break;
      if (!this.neighborhoodReady(candidate.chunk)) continue;
      this.meshChunk(candidate.chunk, deadline);
      worked = true;
    }

    this.stats.chunksLoaded = this.chunks.size;
    this.stats.pending = this.pending.length;
    return worked || this.pending.length > 0;
  }

  /**
   * Point the world at a position and build its load queue without doing any
   * generation work. Call this before driving `update` from a loading screen,
   * so there is a real total to report progress against.
   */
  prepare(cameraPosition) {
    this.centerX = toChunkCoord(cameraPosition.x);
    this.centerZ = toChunkCoord(cameraPosition.z);
    this.pendingDirty = false;
    this.rebuildPending();
    return this.pending.length;
  }

  /** True once every chunk in view has been generated and meshed. */
  isViewComplete() {
    // A queue that has not been built yet is not the same as an empty one.
    if (this.pendingDirty) return false;
    if (this.pending.length > 0) return false;
    for (const chunk of this.chunks.values()) {
      if (chunk.state < ChunkState.GENERATED) return false;
      if (chunk.dirtySections.size > 0 && this.neighborhoodReady(chunk)) return false;
    }
    return true;
  }

  /** Rebuild the load queue, ordered so the nearest chunk is popped first. */
  rebuildPending() {
    const radius = this.renderDistance;
    const wanted = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance > radius + 0.5) continue;
        const cx = this.centerX + dx;
        const cz = this.centerZ + dz;
        const existing = this.chunks.get(chunkKey(cx, cz));
        if (existing && existing.state >= ChunkState.GENERATED) continue;
        wanted.push({ cx, cz, distance });
      }
    }
    // Sorted descending so `pop()` yields the closest chunk.
    wanted.sort((a, b) => b.distance - a.distance);
    this.pending = wanted;
  }

  unloadDistant() {
    const limit = this.renderDistance + 2;
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - this.centerX;
      const dz = chunk.cz - this.centerZ;
      if (Math.sqrt(dx * dx + dz * dz) <= limit) continue;
      // Capture edits before the chunk goes away, or a player who builds and
      // then walks off loses the build at the next autosave.
      if (this.dirtyEdits.has(key)) {
        this.captureEdits(key);
        this.dirtyEdits.delete(key);
      }
      this.removeChunkMeshes(chunk);
      chunk.dispose();
      this.chunks.delete(key);
    }
  }

  generateChunk(chunk) {
    chunk.state = ChunkState.GENERATING;
    this.generator.generateChunk(chunk);

    // Replay this chunk's saved edits over the freshly generated terrain.
    const saved = this.savedEdits.get(chunkKey(chunk.cx, chunk.cz));
    if (saved) chunk.applyEdits(saved.keys, saved.values);

    chunk.rebuildHeightmap(this.tables.opaque);
    computeChunkLight(chunk, this.tables);
    chunk.bordersLit = false;
    chunk.state = ChunkState.LIT;

    // Mark every section up to just above the terrain; the empty sky above it
    // has nothing to draw.
    let maxHeight = 0;
    for (let i = 0; i < chunk.heightmap.length; i++) {
      if (chunk.heightmap[i] > maxHeight) maxHeight = chunk.heightmap[i];
    }
    const topSection = Math.min(SECTION_COUNT - 1, (maxHeight >> 4) + 1);
    for (let sy = 0; sy <= topSection; sy++) chunk.markSectionDirty(sy);

    // A new chunk changes what its neighbours' edge faces look like.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = this.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!neighbor || neighbor.state < ChunkState.LIT) continue;
      for (let sy = 0; sy <= topSection; sy++) neighbor.markSectionDirty(sy);
    }
  }

  /** Meshing needs all eight neighbours present so borders resolve correctly. */
  neighborhoodReady(chunk) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighbor = this.getChunk(chunk.cx + dx, chunk.cz + dz);
        if (!neighbor || neighbor.state < ChunkState.LIT) return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Meshing
  // -------------------------------------------------------------------------

  meshChunk(chunk, deadline) {
    // The first time a chunk is meshed, its whole neighbourhood exists, so this
    // is the earliest moment light can legally cross its seams.
    if (!chunk.bordersLit) {
      chunk.bordersLit = true;
      this.light.reconcileBorders(chunk);
    }

    this.cacheNeighbors(chunk);
    this.buildPaddedTint(chunk);

    for (const sy of [...chunk.dirtySections]) {
      if (performance.now() >= deadline) return;
      chunk.dirtySections.delete(sy);
      this.meshSectionOf(chunk, sy);
    }
    chunk.state = ChunkState.READY;
  }

  cacheNeighbors(chunk) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.neighborCache[(dz + 1) * 3 + (dx + 1)] = this.getChunk(chunk.cx + dx, chunk.cz + dz);
      }
    }
  }

  /** Resolve a chunk-local coordinate that may spill into a neighbour. */
  neighborFor(x, z) {
    const nx = x < 0 ? 0 : x >= CHUNK_SIZE ? 2 : 1;
    const nz = z < 0 ? 0 : z >= CHUNK_SIZE ? 2 : 1;
    return this.neighborCache[nz * 3 + nx];
  }

  /** Copy the 18x18 column tints the mesher needs from the 3x3 neighbourhood. */
  buildPaddedTint(chunk) {
    void chunk;
    for (let z = -1; z <= CHUNK_SIZE; z++) {
      for (let x = -1; x <= CHUNK_SIZE; x++) {
        const source = this.neighborFor(x, z);
        const out = ((z + 1) * PADDED_SIZE + (x + 1)) * TINT_STRIDE;
        if (!source) {
          this.scratchTint.fill(255, out, out + TINT_STRIDE);
          continue;
        }
        const lx = (x + CHUNK_SIZE) & (CHUNK_SIZE - 1);
        const lz = (z + CHUNK_SIZE) & (CHUNK_SIZE - 1);
        const from = (lz * CHUNK_SIZE + lx) * TINT_STRIDE;
        for (let k = 0; k < TINT_STRIDE; k++) {
          this.scratchTint[out + k] = source.tint[from + k];
        }
      }
    }
  }

  meshSectionOf(chunk, sy) {
    const baseY = sy * SECTION_HEIGHT;
    const blocks = this.scratchBlocks;
    const light = this.scratchLight;

    for (let z = -1; z <= SECTION_HEIGHT; z++) {
      for (let x = -1; x <= SECTION_HEIGHT; x++) {
        const source = this.neighborFor(x, z);
        const lx = (x + CHUNK_SIZE) & (CHUNK_SIZE - 1);
        const lz = (z + CHUNK_SIZE) & (CHUNK_SIZE - 1);
        for (let y = -1; y <= SECTION_HEIGHT; y++) {
          const i = paddedIndex(x, y, z);
          const wy = baseY + y;
          if (!source || wy < 0 || wy >= WORLD_HEIGHT) {
            blocks[i] = AIR;
            // Treat the void above the world as fully lit so the top of the
            // terrain is not silhouetted against a dark band.
            light[i] = wy >= WORLD_HEIGHT ? 0xf0 : 0;
            continue;
          }
          blocks[i] = source.getBlock(lx, wy, lz);
          light[i] = (source.getSkyLight(lx, wy, lz) << 4) | source.getBlockLight(lx, wy, lz);
        }
      }
    }

    const result = meshSection(blocks, light, this.scratchTint, this.tables);
    this.applySectionMesh(chunk, sy, result);
  }

  applySectionMesh(chunk, sy, result) {
    const buckets = [
      [Bucket.OPAQUE, result.opaque, this.materials.opaque],
      [Bucket.CUTOUT, result.cutout, this.materials.cutout],
      [Bucket.TRANSPARENT, result.transparent, this.materials.water],
    ];

    for (const [bucket, data, material] of buckets) {
      const key = sy * 3 + bucket;
      const existing = chunk.meshes.get(key);

      if (!data) {
        if (existing) {
          this.group.remove(existing);
          existing.geometry.dispose();
          chunk.meshes.delete(key);
        }
        continue;
      }

      const geometry = buildGeometry(data);
      // Chunk meshes never move, so a manually maintained bounding sphere is
      // both cheaper and safe for frustum culling.
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(CHUNK_SIZE / 2, SECTION_HEIGHT / 2, CHUNK_SIZE / 2),
        Math.sqrt(3) * SECTION_HEIGHT * 0.5 + 1,
      );

      if (existing) {
        existing.geometry.dispose();
        existing.geometry = geometry;
      } else {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(chunk.cx * CHUNK_SIZE, sy * SECTION_HEIGHT, chunk.cz * CHUNK_SIZE);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.renderOrder = bucket;
        mesh.frustumCulled = true;
        chunk.meshes.set(key, mesh);
        this.group.add(mesh);
      }
    }
  }

  removeChunkMeshes(chunk) {
    for (const mesh of chunk.meshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    chunk.meshes.clear();
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  /**
   * Find a safe standing position near the origin: above sea level, on solid
   * ground, and not inside a tree.
   */
  findSpawn() {
    const generator = this.generator;
    for (let radius = 0; radius < 2400; radius += 24) {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
        const x = Math.round(Math.cos(angle) * radius);
        const z = Math.round(Math.sin(angle) * radius);
        const height = generator.heightAt(x, z);
        if (height <= 63) continue;
        const biome = generator.biomeAt(x, z, height);
        // Avoid spawning on a cliff edge.
        const neighbors = [
          generator.heightAt(x + 2, z), generator.heightAt(x - 2, z),
          generator.heightAt(x, z + 2), generator.heightAt(x, z - 2),
        ];
        const spread = Math.max(...neighbors) - Math.min(...neighbors);
        if (spread > 3) continue;
        return { x: x + 0.5, y: height + 2, z: z + 0.5, biome };
      }
    }
    return { x: 0.5, y: 80, z: 0.5, biome: 4 };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Snapshot one chunk's edit list into the save queue. */
  captureEdits(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    const record = chunk.serializeEdits();
    if (!record) return;
    // Keep the in-memory copy current too, so a chunk that unloads and reloads
    // in the same session still comes back edited.
    this.savedEdits.set(key, record);
    this.pendingWrites.set(key, record);
  }

  /**
   * Collect everything that needs writing to disk and clear the queue.
   * Returns an array of `{cx, cz, keys, values}` records.
   */
  takePendingWrites() {
    for (const key of this.dirtyEdits) this.captureEdits(key);
    this.dirtyEdits.clear();
    const writes = [...this.pendingWrites.values()];
    this.pendingWrites.clear();
    return writes;
  }

  get hasUnsavedChanges() {
    return this.dirtyEdits.size > 0 || this.pendingWrites.size > 0;
  }

  dispose() {
    for (const chunk of this.chunks.values()) {
      this.removeChunkMeshes(chunk);
      chunk.dispose();
    }
    this.chunks.clear();
    this.scene.remove(this.group);
  }
}
