/**
 * Particle system.
 *
 * One `THREE.Points` draw for every particle in the world. Particles are kept
 * in flat arrays with a swap-remove free list, so an expiring particle costs a
 * copy rather than a reallocation, and the vertex buffers are only uploaded for
 * the live range each frame.
 *
 * Colours come from the block that spawned them, sampled from the same painted
 * texture the block is rendered with, so a broken block scatters in its own
 * colour rather than a generic puff.
 */

import * as THREE from 'three';

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aFade;

  uniform float uScale;

  varying vec3 vColor;
  varying float vFade;
  varying float vDepth;

  void main() {
    vColor = aColor;
    vFade = aFade;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mvPosition.z;
    // Perspective-correct size: a particle keeps its world size as it recedes.
    gl_PointSize = max(1.0, aSize * uScale / max(vDepth, 0.0001));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uDaylight;
  uniform float uUnderwater;
  uniform vec3 uUnderwaterColor;

  varying vec3 vColor;
  varying float vFade;
  varying float vDepth;

  void main() {
    // Square particles with a darkened rim, so they read as tiny cubes rather
    // than dots and stay consistent with the voxel look.
    vec2 local = gl_PointCoord - 0.5;
    float rim = max(abs(local.x), abs(local.y));
    vec3 color = vColor * (0.72 + 0.55 * uDaylight) * (1.0 - rim * 0.5);

    vec3 fogColor = mix(uFogColor, uUnderwaterColor, uUnderwater);
    float d = vDepth * uFogDensity;
    float fog = 1.0 - exp(-d * d);
    fog = mix(fog, 1.0 - exp(-vDepth * 0.06), uUnderwater);
    color = mix(color, fogColor, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(color, vFade);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const GRAVITY = 22;

export class Particles {
  /**
   * @param {THREE.Scene} scene
   * @param {object} options
   * @param {import('../render/materials.js').WorldMaterials} options.materials
   *   shared so particles fog and dim exactly like the terrain around them
   */
  constructor(scene, { capacity = 2600, materials } = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this.count = 0;

    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.fades = new Float32Array(capacity);

    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    /** 0 = ignores terrain, 1 = collides and settles. */
    this.grounded = new Uint8Array(capacity);
    this.gravityScale = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('aFade', new THREE.BufferAttribute(this.fades, 1));
    geometry.setDrawRange(0, 0);
    // Particles are placed in world space already, so no culling volume is
    // meaningful for the single points object.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = geometry;

    const shared = materials?.uniforms;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 420 },
        uFogColor: shared ? shared.uFogHorizon : { value: new THREE.Vector3(0.6, 0.72, 0.9) },
        uFogDensity: shared ? shared.uFogDensity : { value: 0.006 },
        uDaylight: shared ? shared.uDaylight : { value: 1 },
        uUnderwater: shared ? shared.uUnderwater : { value: 0 },
        uUnderwaterColor: shared ? shared.uUnderwaterColor : { value: new THREE.Vector3(0.05, 0.18, 0.34) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    this.material.name = 'particles';

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  /** Scale point size with the drawing buffer so particles look the same at any resolution. */
  setViewportHeight(pixels) {
    // Guarded for the same reason the cameras are: a zero-height viewport is
    // briefly reported on minimise, and a zero scale makes every particle
    // vanish until the next real measurement.
    if (!Number.isFinite(pixels) || pixels < 1) return;
    this.material.uniforms.uScale.value = pixels * 0.55;
  }

  /**
   * Add one particle. Silently drops the oldest slot when full, which is the
   * right failure mode: a missing particle in a heavy burst is invisible.
   */
  spawn(x, y, z, vx, vy, vz, color, size, life, { collide = true, gravity = 1 } = {}) {
    const i = this.count < this.capacity ? this.count++ : Math.floor(Math.random() * this.capacity);

    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.colors[i * 3] = color[0];
    this.colors[i * 3 + 1] = color[1];
    this.colors[i * 3 + 2] = color[2];

    this.baseSize[i] = size;
    this.sizes[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.fades[i] = 1;
    this.grounded[i] = collide ? 1 : 0;
    this.gravityScale[i] = gravity;
  }

  /** Cloud of block fragments filling the broken block's volume. */
  blockBreak(x, y, z, color, amount = 26) {
    for (let i = 0; i < amount; i++) {
      this.spawn(
        x + Math.random(), y + Math.random(), z + Math.random(),
        (Math.random() - 0.5) * 3.4,
        Math.random() * 3.6 + 0.6,
        (Math.random() - 0.5) * 3.4,
        color,
        0.09 + Math.random() * 0.07,
        0.7 + Math.random() * 0.6,
      );
    }
  }

  /** Small spray off the face being mined, thrown back toward the player. */
  blockHit(x, y, z, nx, ny, nz, color, amount = 4) {
    for (let i = 0; i < amount; i++) {
      // Spawn on the struck face, offset just clear of it.
      const ox = nx !== 0 ? (nx > 0 ? 1.02 : -0.02) : Math.random();
      const oy = ny !== 0 ? (ny > 0 ? 1.02 : -0.02) : Math.random();
      const oz = nz !== 0 ? (nz > 0 ? 1.02 : -0.02) : Math.random();
      this.spawn(
        x + ox, y + oy, z + oz,
        nx * 1.6 + (Math.random() - 0.5) * 1.4,
        ny * 1.6 + Math.random() * 1.4 + 0.4,
        nz * 1.6 + (Math.random() - 0.5) * 1.4,
        color,
        0.06 + Math.random() * 0.05,
        0.35 + Math.random() * 0.3,
      );
    }
  }

  /** Dust kicked up by a footfall. */
  footstep(x, y, z, color, amount = 5) {
    for (let i = 0; i < amount; i++) {
      this.spawn(
        x + (Math.random() - 0.5) * 0.5, y + 0.06, z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 1.1, Math.random() * 0.9, (Math.random() - 0.5) * 1.1,
        color,
        0.05 + Math.random() * 0.04,
        0.3 + Math.random() * 0.25,
      );
    }
  }

  /** Water thrown up on entry, plus a ring of droplets. */
  splash(x, y, z, amount = 30) {
    const color = [0.55, 0.78, 1.0];
    for (let i = 0; i < amount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 3.2;
      this.spawn(
        x + (Math.random() - 0.5) * 0.7, y + 0.1, z + (Math.random() - 0.5) * 0.7,
        Math.cos(angle) * speed, 2.4 + Math.random() * 3.2, Math.sin(angle) * speed,
        color,
        0.05 + Math.random() * 0.05,
        0.4 + Math.random() * 0.4,
        { collide: false },
      );
    }
  }

  /** Rising embers, used where lava meets air. */
  ember(x, y, z, amount = 3) {
    for (let i = 0; i < amount; i++) {
      this.spawn(
        x + Math.random(), y + 1.02, z + Math.random(),
        (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 1.2, (Math.random() - 0.5) * 0.5,
        [1.0, 0.55 + Math.random() * 0.3, 0.18],
        0.05 + Math.random() * 0.05,
        0.9 + Math.random() * 0.8,
        { collide: false, gravity: -0.12 },
      );
    }
  }

  /**
   * Advance every live particle and compact the arrays.
   *
   * Compaction happens in the same pass as integration: a dead particle is
   * overwritten by the last live one, so there is never a second sweep and the
   * draw range is always exactly the live count.
   */
  update(delta, world) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= delta;
      if (this.life[i] <= 0) {
        this.removeAt(i);
        continue;
      }

      const p = i * 3;
      this.velocities[p + 1] -= GRAVITY * this.gravityScale[i] * delta;

      // Air drag, so fragments lose their initial scatter and settle.
      const drag = Math.exp(-2.2 * delta);
      this.velocities[p] *= drag;
      this.velocities[p + 2] *= drag;

      let nx = this.positions[p] + this.velocities[p] * delta;
      let ny = this.positions[p + 1] + this.velocities[p + 1] * delta;
      let nz = this.positions[p + 2] + this.velocities[p + 2] * delta;

      if (this.grounded[i] && world) {
        const solid = world.tables.solid;
        const blockAt = (bx, by, bz) => solid[world.getBlock(bx, by, bz)] === 1;

        if (blockAt(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
          // Resolve against whichever axis moved into the block, so a fragment
          // slides along a wall instead of stopping dead against it.
          if (blockAt(Math.floor(nx), Math.floor(this.positions[p + 1]), Math.floor(this.positions[p + 2]))) {
            nx = this.positions[p];
            this.velocities[p] = 0;
          }
          if (blockAt(Math.floor(this.positions[p]), Math.floor(ny), Math.floor(this.positions[p + 2]))) {
            ny = this.positions[p + 1];
            this.velocities[p + 1] *= -0.22;
            this.velocities[p] *= 0.6;
            this.velocities[p + 2] *= 0.6;
          }
          if (blockAt(Math.floor(this.positions[p]), Math.floor(this.positions[p + 1]), Math.floor(nz))) {
            nz = this.positions[p + 2];
            this.velocities[p + 2] = 0;
          }
        }
      }

      this.positions[p] = nx;
      this.positions[p + 1] = ny;
      this.positions[p + 2] = nz;

      // Fade out over the last third of the lifetime.
      const remaining = this.life[i] / this.maxLife[i];
      this.fades[i] = Math.min(1, remaining * 3);
      this.sizes[i] = this.baseSize[i] * (0.55 + 0.45 * remaining);

      i++;
    }

    this.geometry.setDrawRange(0, this.count);
    if (this.count > 0) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aFade.needsUpdate = true;
    }
  }

  /** Swap-remove, keeping the live particles contiguous at the front. */
  removeAt(index) {
    const last = --this.count;
    if (index === last) return;
    for (let k = 0; k < 3; k++) {
      this.positions[index * 3 + k] = this.positions[last * 3 + k];
      this.velocities[index * 3 + k] = this.velocities[last * 3 + k];
      this.colors[index * 3 + k] = this.colors[last * 3 + k];
    }
    this.sizes[index] = this.sizes[last];
    this.fades[index] = this.fades[last];
    this.life[index] = this.life[last];
    this.maxLife[index] = this.maxLife[last];
    this.baseSize[index] = this.baseSize[last];
    this.grounded[index] = this.grounded[last];
    this.gravityScale[index] = this.gravityScale[last];
  }

  clear() {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
