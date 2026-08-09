/**
 * The animals in a world: spawning, despawning, and drawing all of them.
 *
 * Every animal in view is drawn as one mesh. That is the whole reason this
 * module rebuilds vertex data on the CPU each frame instead of parenting boxes
 * into a scene graph: a herd of cows is forty boxes, and forty boxes is forty
 * draw calls sitting on top of a world that already spends hundreds. Writing
 * a few thousand transformed vertices into a pre-allocated buffer costs far
 * less than the draw calls it saves, and it keeps every animal in the same
 * material — so they light and fog exactly like the terrain they stand on.
 *
 * Spawning is deliberately local and cheap: candidates are drawn from a ring
 * around the player, tested against the surface the world already knows about,
 * and dropped the moment they wander too far to matter.
 */

import * as THREE from 'three';
import { createModelMaterial, applySkyToModel } from '../render/model.js';
import { SPECIES, speciesForBiome, pickFleece } from './mob-species.js';
import { Mob } from './mob.js';
import { AIR, GRASS_BLOCK, SAND, PODZOL, MOSS_BLOCK, SNOW_BLOCK, COARSE_DIRT, DIRT } from '../world/blocks.js';
import { CHUNK_SIZE, toChunkCoord, toLocalCoord } from '../world/constants.js';

/** Face order matches the block registry: +X, -X, +Y, -Y, +Z, -Z. */
const FACES = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
];

/** Same facet ramp the world uses, so animals sit in the same light. */
const FACE_SHADE = [0.86, 0.86, 1.0, 0.58, 0.76, 0.76];

/** Blocks an animal is willing to stand on. */
const SPAWNABLE = new Set([GRASS_BLOCK, SAND, PODZOL, MOSS_BLOCK, SNOW_BLOCK, COARSE_DIRT, DIRT]);

const MAX_MOBS = 40;
/** Vertices reserved per animal. The largest species is well under this. */
const VERTS_PER_MOB = 12 * 24;

const SPAWN_INTERVAL = 2.2;
/** Ring the game tries to spawn into, in blocks. Outside the player's view. */
const SPAWN_MIN = 16;
const SPAWN_MAX = 44;
/** Past this, an animal is forgotten. Comfortably beyond the spawn ring. */
const DESPAWN_DISTANCE = 84;

export class MobManager {
  /**
   * @param {object} context
   * @param {THREE.Scene} context.scene
   * @param {import('../world/world.js').World} context.world
   * @param {object} context.atlas
   * @param {import('../core/audio.js').AudioEngine} context.audio
   */
  constructor({ scene, world, atlas, audio }) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;

    /** @type {Mob[]} */
    this.mobs = [];
    this.spawnTimer = 0;
    this.enabled = true;
    /** Scales the population cap; 0 means no animals at all. */
    this.density = 1;

    this.templates = buildTemplates(atlas);
    this.material = createModelMaterial(atlas.texture, { vertexTint: true });
    this.material.name = 'mobs';

    const capacity = MAX_MOBS * VERTS_PER_MOB;
    this.positions = new Float32Array(capacity * 3);
    this.normals = new Float32Array(capacity * 3);
    this.uvs = new Float32Array(capacity * 2);
    this.layers = new Float32Array(capacity);
    this.shade = new Float32Array(capacity);
    this.tints = new Float32Array(capacity * 3);
    this.light = new Float32Array(capacity * 2);
    this.indices = new Uint32Array(capacity * 6);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geometry.setAttribute('layer', new THREE.BufferAttribute(this.layers, 1));
    geometry.setAttribute('faceShade', new THREE.BufferAttribute(this.shade, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(this.tints, 3));
    geometry.setAttribute('aLight', new THREE.BufferAttribute(this.light, 2));
    geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    geometry.setDrawRange(0, 0);
    // Vertices are written in world space, so no local bound is meaningful.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = geometry;

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'mobs';
    scene.add(this.mesh);

    this._body = new THREE.Matrix4();
    this._partMatrix = new THREE.Matrix4();
    this._rotation = new THREE.Matrix4();
    this._world = new THREE.Matrix4();
    this._centre = new THREE.Vector3();

    /** Called with (mob) when one dies, so the session can react. */
    this.onDeath = null;
  }

  get count() {
    return this.mobs.length;
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  get cap() {
    return Math.round(MAX_MOBS * this.density);
  }

  /**
   * @param {number} delta
   * @param {THREE.Vector3} playerPosition
   */
  update(delta, playerPosition) {
    if (!this.enabled) {
      if (this.mobs.length > 0) this.clear();
      this.geometry.setDrawRange(0, 0);
      return;
    }

    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      mob.update(delta, this.world, playerPosition);

      if (mob.wantsVoice) {
        mob.wantsVoice = false;
        this.audio?.voice({ ...mob.species.voice, ...this.pan(mob) });
      }

      if (mob.removed || this.tooFar(mob, playerPosition)) {
        this.mobs.splice(i, 1);
        continue;
      }
      // Sample once per frame rather than per vertex: an animal is small
      // enough that one light level across its whole body is right.
      this.sampleLight(mob);
    }

    this.spawnTimer += delta;
    if (this.spawnTimer >= SPAWN_INTERVAL) {
      this.spawnTimer = 0;
      if (this.mobs.length < this.cap) this.trySpawnGroup(playerPosition);
    }

    this.rebuild();
  }

  tooFar(mob, playerPosition) {
    const dx = mob.position.x - playerPosition.x;
    const dz = mob.position.z - playerPosition.z;
    return dx * dx + dz * dz > DESPAWN_DISTANCE * DESPAWN_DISTANCE;
  }

  sampleLight(mob) {
    const x = Math.floor(mob.position.x);
    const y = Math.floor(mob.position.y + mob.height * 0.5);
    const z = Math.floor(mob.position.z);
    mob.skyLight = this.world.getSkyLight(x, y, z) / 15;
    mob.blockLight = this.world.getBlockLight(x, y, z) / 15;
  }

  /** Try to drop a small herd somewhere in the ring around the player. */
  trySpawnGroup(playerPosition, attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = Math.floor(playerPosition.x + Math.cos(angle) * distance);
      const z = Math.floor(playerPosition.z + Math.sin(angle) * distance);

      const spot = this.groundAt(x, z);
      if (spot === null) return 0;

      const biome = this.biomeAt(x, z);
      const species = speciesForBiome(biome, Math.random);
      if (!species) continue;

      const [min, max] = species.spawn.group;
      const wanted = min + Math.floor(Math.random() * (max - min + 1));
      let spawned = 0;
      for (let i = 0; i < wanted && this.mobs.length < this.cap; i++) {
        // Scatter the herd rather than stacking it on one block.
        const ox = x + Math.floor((Math.random() - 0.5) * 6);
        const oz = z + Math.floor((Math.random() - 0.5) * 6);
        const y = this.groundAt(ox, oz);
        if (y === null) continue;
        this.add(species, ox + 0.5, y, oz + 0.5);
        spawned++;
      }
      if (spawned > 0) return spawned;
    }
    return 0;
  }

  /** Spawn animals right where the player is looking, for `/mobs spawn`. */
  spawnBurst(playerPosition, count = 6) {
    let spawned = 0;
    for (let i = 0; i < count * 6 && spawned < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 3 + Math.random() * 8;
      const x = Math.floor(playerPosition.x + Math.cos(angle) * distance);
      const z = Math.floor(playerPosition.z + Math.sin(angle) * distance);
      const y = this.groundAt(x, z);
      if (y === null) continue;
      const species = speciesForBiome(this.biomeAt(x, z), Math.random)
        ?? SPECIES[['pig', 'cow', 'sheep', 'chicken'][Math.floor(Math.random() * 4)]];
      this.add(species, x + 0.5, y, z + 0.5);
      spawned++;
    }
    return spawned;
  }

  add(species, x, y, z) {
    const mob = new Mob(species, x, y, z, Math.random);
    if (species.fleeceColours) {
      const fleece = pickFleece(Math.random);
      mob.tint = fleece.tint;
      mob.drop = fleece.block;
    }
    this.mobs.push(mob);
    return mob;
  }

  /**
   * Standing height for a column, or null if nothing there will take an
   * animal — no chunk loaded, underwater, or the wrong surface block.
   */
  groundAt(x, z) {
    const chunk = this.world.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (!chunk) return null;
    const height = chunk.getHeight(toLocalCoord(x), toLocalCoord(z));
    if (height <= 0) return null;

    const surface = this.world.getBlock(x, height - 1, z);
    if (!SPAWNABLE.has(surface)) return null;
    // Two blocks of headroom, so nothing spawns inside a tree or a house.
    if (this.world.getBlock(x, height, z) !== AIR) return null;
    if (this.world.getBlock(x, height + 1, z) !== AIR) return null;
    return height;
  }

  biomeAt(x, z) {
    const chunk = this.world.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (!chunk) return 4;
    return chunk.getBiome(toLocalCoord(x), toLocalCoord(z));
  }

  /** Seed the world with animals before the player ever sees it. */
  populate(playerPosition, rounds = 10) {
    let spawned = 0;
    for (let i = 0; i < rounds && this.mobs.length < this.cap; i++) {
      spawned += this.trySpawnGroup(playerPosition, 4);
    }
    return spawned;
  }

  clear() {
    const removed = this.mobs.length;
    this.mobs.length = 0;
    this.geometry.setDrawRange(0, 0);
    return removed;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  /**
   * Nearest animal along a ray, using a slab test against each body box.
   *
   * @returns {{mob: Mob, distance: number}|null}
   */
  raycast(origin, direction, maxDistance) {
    let best = null;
    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const half = mob.width / 2;
      const distance = intersectBox(
        origin, direction,
        mob.position.x - half, mob.position.y, mob.position.z - half,
        mob.position.x + half, mob.position.y + mob.height, mob.position.z + half,
        maxDistance,
      );
      if (distance === null) continue;
      if (!best || distance < best.distance) best = { mob, distance };
    }
    return best;
  }

  /** Apply a hit and play what it sounds like. Returns true when it lands. */
  hit(mob, amount, knockback) {
    const wasAlive = !mob.dead;
    if (!mob.damage(amount, 'attack', knockback)) return false;
    this.audio?.voice({ ...mob.species.hurtVoice, ...this.pan(mob) });
    if (wasAlive && mob.dead) this.onDeath?.(mob);
    return true;
  }

  /** Gain and stereo placement for a sound coming from an animal. */
  pan(mob) {
    const place = this.audio?.spatial(mob.centre(this._centre));
    if (!place) return { gain: 0 };
    return { gain: (mob.species.voice.gain ?? 0.3) * place.gain, pan: place.pan };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Push the current sky into the shared material. */
  applySky(sky, brightness = 1) {
    applySkyToModel(this.material, sky, brightness);
  }

  /**
   * Rewrite the merged geometry from the live animals.
   *
   * Every animal contributes its parts in world space, so the mesh itself has
   * an identity transform and one draw covers the lot.
   */
  rebuild() {
    let vertex = 0;
    let index = 0;

    for (const mob of this.mobs) {
      const template = this.templates[mob.species.name];
      if (!template) continue;
      if (vertex + template.vertexCount > MAX_MOBS * VERTS_PER_MOB) break;

      this.buildMobMatrix(mob, this._body);

      // A hit tints the whole animal red; the flash decays in the mob.
      const flash = mob.hurtFlash;
      const tintR = mob.tint[0] * (1 - flash) + 1.0 * flash;
      const tintG = mob.tint[1] * (1 - flash) + 0.28 * flash;
      const tintB = mob.tint[2] * (1 - flash) + 0.24 * flash;

      for (let p = 0; p < template.parts.length; p++) {
        const part = template.parts[p];
        this.buildPartMatrix(mob, part, this._partMatrix);
        const e = this._world.multiplyMatrices(this._body, this._partMatrix).elements;

        // Fleece is the sheep's coat and the only part its colour applies to;
        // its face and legs stay their own shade.
        const useTint = part.fleece || !template.hasFleece;
        const r = useTint ? tintR : (1 - flash) + 1.0 * flash;
        const g = useTint ? tintG : (1 - flash) + 0.28 * flash;
        const b = useTint ? tintB : (1 - flash) + 0.24 * flash;

        for (let v = 0; v < 24; v++) {
          const px = part.positions[v * 3];
          const py = part.positions[v * 3 + 1];
          const pz = part.positions[v * 3 + 2];
          const nx = part.normals[v * 3];
          const ny = part.normals[v * 3 + 1];
          const nz = part.normals[v * 3 + 2];

          const o3 = vertex * 3;
          this.positions[o3] = e[0] * px + e[4] * py + e[8] * pz + e[12];
          this.positions[o3 + 1] = e[1] * px + e[5] * py + e[9] * pz + e[13];
          this.positions[o3 + 2] = e[2] * px + e[6] * py + e[10] * pz + e[14];
          // Every transform here is a rigid motion, so the rotation block
          // transforms normals correctly without an inverse-transpose.
          this.normals[o3] = e[0] * nx + e[4] * ny + e[8] * nz;
          this.normals[o3 + 1] = e[1] * nx + e[5] * ny + e[9] * nz;
          this.normals[o3 + 2] = e[2] * nx + e[6] * ny + e[10] * nz;

          this.uvs[vertex * 2] = part.uvs[v * 2];
          this.uvs[vertex * 2 + 1] = part.uvs[v * 2 + 1];
          this.layers[vertex] = part.layers[v];
          this.shade[vertex] = part.shade[v];
          this.tints[o3] = r;
          this.tints[o3 + 1] = g;
          this.tints[o3 + 2] = b;
          this.light[vertex * 2] = mob.skyLight;
          this.light[vertex * 2 + 1] = mob.blockLight;
          vertex++;
        }

        // Six faces of four vertices, wound to face outward.
        const base = vertex - 24;
        for (let f = 0; f < 6; f++) {
          const corner = base + f * 4;
          this.indices[index++] = corner;
          this.indices[index++] = corner + 2;
          this.indices[index++] = corner + 1;
          this.indices[index++] = corner;
          this.indices[index++] = corner + 3;
          this.indices[index++] = corner + 2;
        }
      }
    }

    this.geometry.setDrawRange(0, index);
    if (index === 0) return;

    // Only the written range is uploaded, so an empty field costs nothing.
    markUpdated(this.geometry.attributes.position, vertex * 3);
    markUpdated(this.geometry.attributes.normal, vertex * 3);
    markUpdated(this.geometry.attributes.uv, vertex * 2);
    markUpdated(this.geometry.attributes.layer, vertex);
    markUpdated(this.geometry.attributes.faceShade, vertex);
    markUpdated(this.geometry.attributes.aTint, vertex * 3);
    markUpdated(this.geometry.attributes.aLight, vertex * 2);
    markUpdated(this.geometry.index, index);
  }

  /** Body-to-world: stand it up, turn it, and topple it if it is dead. */
  buildMobMatrix(mob, out) {
    out.makeTranslation(mob.position.x, mob.position.y, mob.position.z);
    out.multiply(this._rotation.makeRotationY(mob.yaw));
    if (mob.dead) {
      // Roll onto its side about the feet, which is the whole death animation.
      out.multiply(this._rotation.makeRotationZ(mob.deathProgress * Math.PI * 0.5));
    }
  }

  /**
   * Part-to-body: move to the joint, apply this part's motion, and leave the
   * box positioned relative to that joint.
   *
   * A part with `attachTo` rotates about a *different* joint from the one it
   * sits at — a horn turns around the neck while sitting on the forehead — so
   * its offset from that joint is applied after the rotation.
   */
  buildPartMatrix(mob, part, out) {
    const joint = part.attachTo ?? part.pivot;
    out.makeTranslation(joint[0], joint[1], joint[2]);

    const swing = Math.sin(mob.walkPhase) * mob.walkAmount * 0.9;
    switch (part.motion) {
      case 'head':
        out.multiply(this._rotation.makeRotationY(mob.headYaw));
        out.multiply(this._rotation.makeRotationX(mob.headPitch));
        break;
      case 'legA':
        out.multiply(this._rotation.makeRotationX(swing));
        break;
      case 'legB':
        out.multiply(this._rotation.makeRotationX(-swing));
        break;
      case 'wing':
        out.multiply(this._rotation.makeRotationZ(
          part.side * (0.2 + Math.abs(Math.sin(mob.wingPhase)) * 1.1),
        ));
        break;
      default:
        break;
    }

    if (part.attachTo) {
      out.multiply(this._rotation.makeTranslation(
        part.pivot[0] - joint[0],
        part.pivot[1] - joint[1],
        part.pivot[2] - joint[2],
      ));
    }
    return out;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mobs.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Geometry templates
// ---------------------------------------------------------------------------

/**
 * Pre-transform every species into flat per-part vertex arrays.
 *
 * The heavy part of drawing a mob — laying out its boxes, resolving texture
 * names to atlas layers, working out face shading — never changes, so it is
 * done once here and the per-frame path is only a matrix multiply.
 */
function buildTemplates(atlas) {
  const templates = {};
  for (const name of Object.keys(SPECIES)) {
    const species = SPECIES[name];
    const parts = species.parts.map((part) => buildPart(part, atlas));
    templates[name] = {
      parts,
      vertexCount: parts.length * 24,
      hasFleece: species.parts.some((part) => part.fleece),
    };
  }
  return templates;
}

function buildPart(part, atlas) {
  const [width, height, depth] = part.size;
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const layers = new Float32Array(24);
  const shade = new Float32Array(24);

  // Boxes are centred in X and Z and rise from the pivot. A hanging part — a
  // leg, a wing — drops below it instead, so rotating it swings from the
  // joint rather than spinning about the foot.
  const origin = [-width / 2, part.hang ? -height : 0, -depth / 2];
  const size = [width, height, depth];

  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const layer = atlas.tileIndexByName.get(part.layers[f]) ?? 0;
    for (let c = 0; c < 4; c++) {
      const v = f * 4 + c;
      for (let axis = 0; axis < 3; axis++) {
        positions[v * 3 + axis] = origin[axis] + face.corners[c][axis] * size[axis];
        normals[v * 3 + axis] = face.normal[axis];
      }
      uvs[v * 2] = face.uv[c][0];
      uvs[v * 2 + 1] = face.uv[c][1];
      layers[v] = layer;
      shade[v] = FACE_SHADE[f];
    }
  }

  return {
    positions,
    normals,
    uvs,
    layers,
    shade,
    motion: part.motion,
    side: part.side ?? 1,
    fleece: Boolean(part.fleece),
    pivot: part.pivot,
    attachTo: part.attachTo ?? null,
  };
}

/** Upload only the range that was written this frame. */
function markUpdated(attribute, count) {
  attribute.needsUpdate = true;
  attribute.clearUpdateRanges?.();
  attribute.addUpdateRange?.(0, count);
}

/**
 * Slab test of a ray against an axis-aligned box.
 * @returns {number|null} distance along the ray, or null for a miss
 */
function intersectBox(origin, direction, minX, minY, minZ, maxX, maxY, maxZ, maxDistance) {
  let near = 0;
  let far = maxDistance;

  const bounds = [[minX, maxX], [minY, maxY], [minZ, maxZ]];
  const from = [origin.x, origin.y, origin.z];
  const along = [direction.x, direction.y, direction.z];

  for (let axis = 0; axis < 3; axis++) {
    const d = along[axis];
    const [lo, hi] = bounds[axis];
    if (Math.abs(d) < 1e-8) {
      // Parallel to this pair of planes: a miss unless already between them.
      if (from[axis] < lo || from[axis] > hi) return null;
      continue;
    }
    let t0 = (lo - from[axis]) / d;
    let t1 = (hi - from[axis]) / d;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return null;
  }

  return near;
}
