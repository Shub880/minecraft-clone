/**
 * Sun shadow map.
 *
 * The world's baked skylight already knows what is under a roof, but it knows
 * nothing about the *direction* the sun is coming from: at eight in the
 * morning a tree lays no shadow across the grass beside it, and a wall lights
 * the same on both faces. That absence is most of what separates a voxel
 * renderer from a shader pack, and it is the one thing per-vertex lighting can
 * never supply.
 *
 * So the world is drawn a second time from the sun's point of view into a depth
 * texture, and the terrain shader asks that texture whether each pixel could
 * see the sun. Only a box around the player is covered — a few dozen blocks,
 * where shadows are legible — and the edge is faded out rather than cut, so the
 * boundary never shows as a line across the ground.
 *
 * Two details do most of the work in keeping it free of artefacts:
 *
 *   snapping   the light camera is moved in whole texels, so walking does not
 *              make every shadow edge crawl and shimmer
 *   normal offset  samples are pushed off the surface along its normal rather
 *              than biased in depth alone, which is what stops a flat lit
 *              floor from shadowing itself in stripes
 */

import * as THREE from 'three';

/** Map size and covered radius, in texels and blocks. */
export const SHADOW_QUALITY = {
  low: { size: 1024, radius: 42 },
  medium: { size: 2048, radius: 60 },
  high: { size: 3072, radius: 80 },
};

/**
 * How far back along the sun ray the light camera sits.
 *
 * Kept as short as the terrain allows: the whole near-to-far range is what the
 * stored depth has to resolve, and halving it halves the bias needed to keep a
 * lit surface from shadowing itself.
 */
const LIGHT_DISTANCE = 160;

const DEPTH_VERTEX = /* glsl */ `
  attribute float layer;

  varying vec2 vUv;
  varying float vLayer;
  varying float vDepth;

  void main() {
    vUv = uv;
    vLayer = layer;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // The light camera is orthographic, so clip z is already linear in
    // distance; remapping it to 0..1 here matches what the terrain shader
    // computes from the same matrices.
    vDepth = clip.z * 0.5 + 0.5;
    gl_Position = clip;
  }
`;

/**
 * Distance from the light, written as colour.
 *
 * Reading depth back out of a depth *texture* is the obvious way to do this
 * and turned out not to be: the attachment stayed empty under this renderer,
 * and a shadow term that silently always says "lit" is invisible until you go
 * looking for it. Writing the same number into a float colour target costs one
 * extra channel of bandwidth and cannot fail quietly — if the pass draws
 * nothing, the map is uniformly far away and that is exactly what it means.
 *
 * The cutout variant is the reason this is not `MeshDepthMaterial`: leaves and
 * plants have to discard on the atlas layer their vertices name, or every tree
 * would cast the shadow of a solid cube.
 */
const DEPTH_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uAtlas;

  varying vec2 vUv;
  varying float vLayer;
  varying float vDepth;

  void main() {
    #ifdef CUTOUT
      if (texture(uAtlas, vec3(vUv, vLayer)).a < 0.5) discard;
    #endif
    gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0);
  }
`;

export class SunShadows {
  /**
   * @param {THREE.DataArrayTexture} atlasTexture  for cutout casters
   * @param {keyof SHADOW_QUALITY} [quality]
   */
  constructor(atlasTexture, quality = 'medium') {
    this.atlasTexture = atlasTexture;
    this.enabled = true;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, LIGHT_DISTANCE * 2);
    /** World space to shadow-map texture space, including the 0..1 remap. */
    this.matrix = new THREE.Matrix4();
    this.texel = new THREE.Vector2();

    this.depthOpaque = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: atlasTexture } },
      vertexShader: DEPTH_VERTEX,
      fragmentShader: DEPTH_FRAGMENT,
      side: THREE.FrontSide,
    });
    this.depthOpaque.name = 'shadow-depth';

    this.depthCutout = new THREE.ShaderMaterial({
      defines: { CUTOUT: '' },
      uniforms: { uAtlas: { value: atlasTexture } },
      vertexShader: DEPTH_VERTEX,
      fragmentShader: DEPTH_FRAGMENT,
      // Double sided, like the world's cutout pass, so a plant seen edge-on
      // from the sun still casts something.
      side: THREE.DoubleSide,
    });
    this.depthCutout.name = 'shadow-depth-cutout';

    this.target = null;
    this.setQuality(quality);

    this._center = new THREE.Vector3();
    this._snapped = new THREE.Vector3();
    this._swapped = [];
    this._hidden = [];
    this._clearColor = new THREE.Color();
    this._bias = new THREE.Matrix4().set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
  }

  setQuality(name) {
    const quality = SHADOW_QUALITY[name] ?? SHADOW_QUALITY.medium;
    if (this.quality === name && this.target) return;
    this.quality = name;
    this.radius = quality.radius;

    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(quality.size, quality.size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      // One channel is all a distance needs, and at three thousand texels
      // square the three it saves are worth more than the simplicity.
      format: THREE.RedFormat,
      // Float, so a distance of a few hundred blocks still resolves to well
      // under one. Half float leaves about a fifth of a block of slop, which
      // is enough to stripe a lit floor with its own shadow.
      type: THREE.FloatType,
      // A real depth buffer is still wanted, so the nearest caster wins within
      // the pass; it is simply never read afterwards.
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;

    this.size = quality.size;
    this.texel.set(1 / quality.size, 1 / quality.size);
    this.worldTexel = (this.radius * 2) / quality.size;

    this.camera.left = -this.radius;
    this.camera.right = this.radius;
    this.camera.top = this.radius;
    this.camera.bottom = -this.radius;
    this.camera.updateProjectionMatrix();
  }

  /** The map itself: distance from the light in the red channel. */
  get depthTexture() {
    return this.target.texture;
  }

  /**
   * Aim the light camera at the player.
   *
   * Snapping happens in the light's own space, not the world's: the shadow map
   * is a grid in *that* space, and rounding a world coordinate would leave the
   * texels sliding underneath the scene as the sun moves.
   */
  update(sunDirection, focus) {
    this._center.copy(focus);
    // Push the covered box slightly ahead of the player, since more of the
    // screen is in front of them than behind.
    this._center.y += 2;

    const camera = this.camera;
    camera.position.copy(this._center).addScaledVector(sunDirection, LIGHT_DISTANCE);
    camera.up.set(0, 1, 0);
    // A sun directly overhead makes the default up vector degenerate.
    if (Math.abs(sunDirection.y) > 0.999) camera.up.set(0, 0, 1);
    camera.lookAt(this._center);
    camera.updateMatrixWorld();

    this._snapped.copy(this._center).applyMatrix4(camera.matrixWorldInverse);
    this._snapped.x = Math.round(this._snapped.x / this.worldTexel) * this.worldTexel;
    this._snapped.y = Math.round(this._snapped.y / this.worldTexel) * this.worldTexel;
    this._snapped.applyMatrix4(camera.matrixWorld);

    camera.position.copy(this._snapped).addScaledVector(sunDirection, LIGHT_DISTANCE);
    camera.lookAt(this._snapped);
    camera.updateMatrixWorld();

    this.matrix
      .copy(this._bias)
      .multiply(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
  }

  /**
   * Draw every caster into the depth map.
   *
   * Materials are swapped in place rather than using `scene.overrideMaterial`,
   * because the choice is not uniform: solid blocks want the plain depth
   * material, leaves want the one that discards, and water should not cast a
   * shadow at all.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {{chunks: THREE.Object3D, casters?: THREE.Object3D[], hidden?: THREE.Object3D[]}} plan
   */
  render(renderer, scene, plan) {
    const swapped = this._swapped;
    const hidden = this._hidden;
    swapped.length = 0;
    hidden.length = 0;

    for (const mesh of plan.chunks.children) {
      const name = mesh.material?.name;
      if (name === 'chunk-water') {
        mesh.visible = false;
        hidden.push(mesh);
        continue;
      }
      swapped.push(mesh, mesh.material);
      mesh.material = name === 'chunk-cutout' ? this.depthCutout : this.depthOpaque;
    }

    for (const object of plan.casters ?? []) {
      object.traverse((child) => {
        if (!child.isMesh || !child.visible) return;
        swapped.push(child, child.material);
        child.material = this.depthOpaque;
      });
    }

    for (const object of plan.hidden ?? []) {
      if (!object || !object.visible) continue;
      object.visible = false;
      hidden.push(object);
    }

    const previousTarget = renderer.getRenderTarget();
    renderer.getClearColor(this._clearColor);
    const previousAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.target);
    // White is "nothing here": an unwritten texel has to read as further away
    // than any real surface, or empty sky would shadow the ground under it.
    renderer.setClearColor(0xffffff, 1);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(this._clearColor, previousAlpha);

    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    for (const object of hidden) object.visible = true;
    swapped.length = 0;
    hidden.length = 0;
  }

  dispose() {
    this.target?.dispose();
    this.depthOpaque.dispose();
    this.depthCutout.dispose();
  }
}
