/**
 * First-person view model: the block (or hand) held in front of the camera.
 *
 * Drawn into its own scene with its own camera and composited over the world
 * with the depth buffer cleared. That is the only reliable way to keep a held
 * object out of the terrain: at a 0.08 near plane, a model placed in the world
 * scene close enough to fill the corner of the screen will clip through
 * anything the player stands next to.
 *
 * The animation is all procedural — an idle bob driven by walking speed and a
 * swing curve triggered by using the item.
 */

import * as THREE from 'three';
import { BLOCKS, Render } from '../world/blocks.js';
import {
  buildBoxGeometry, buildCrossGeometry, createModelMaterial, applySkyToModel, setBoxLayers,
} from './model.js';

/** Seconds for one full swing. */
const SWING_DURATION = 0.26;

/**
 * Resting placement of the held models, in view space.
 *
 * Distance is doing the work here rather than scale: at a 68° field of view the
 * visible half-height at z is 0.67z, so pushing the model back to about one
 * unit is what keeps a held block to roughly a fifth of the screen instead of a
 * quarter of the viewport.
 */
const BLOCK_REST = new THREE.Vector3(0.62, -0.5, -1.05);
const ARM_REST = new THREE.Vector3(0.54, -0.58, -1.0);

const BLOCK_SIZE = 0.32;

export class ViewModel {
  /**
   * @param {{texture: THREE.DataArrayTexture, tileIndexByName: Map<string, number>}} atlas
   */
  constructor(atlas) {
    this.atlas = atlas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.01, 12);

    this.material = createModelMaterial(atlas.texture);
    // Plants are drawn double sided and genuinely cut out, like in the world.
    this.crossMaterial = createModelMaterial(atlas.texture, { cutout: true });
    this.crossMaterial.side = THREE.DoubleSide;

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    // Cube for ordinary blocks. Layers are rewritten in place on every change,
    // so switching hotbar slots never allocates.
    this.cube = new THREE.Mesh(
      buildBoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE, [0, 0, 0, 0, 0, 0]),
      this.material,
    );
    this.cube.position.copy(BLOCK_REST);
    this.cube.rotation.set(0.18, -0.62, 0.08);
    this.pivot.add(this.cube);

    // Cross geometry is rebuilt on change; plants are rare enough in the hand
    // that a small allocation on switch is cheaper than keeping six variants.
    this.cross = new THREE.Mesh(buildCrossGeometry(0, 0.4), this.crossMaterial);
    this.cross.position.set(BLOCK_REST.x, BLOCK_REST.y - 0.14, BLOCK_REST.z);
    this.cross.rotation.set(0, -0.5, 0.12);
    this.cross.visible = false;
    this.pivot.add(this.cross);

    // The arm is built from its shoulder down, then angled in from the corner
    // of the screen so the hand sits under the crosshair rather than beside it.
    const armLayer = atlas.tileIndexByName.get('skin_arm') ?? 0;
    const armGeometry = buildBoxGeometry(0.115, 0.42, 0.115, new Array(6).fill(armLayer));
    armGeometry.translate(0, -0.42, 0);
    this.arm = new THREE.Mesh(armGeometry, this.material);
    this.arm.position.copy(ARM_REST);
    this.arm.rotation.set(-1.05, 0.12, -0.42);
    this.pivot.add(this.arm);

    this.heldId = -1;
    this.swingTime = -1;
    this.bob = new THREE.Vector3();
    this.enabled = true;

    this.setHeld(0);
  }

  /** Choose which model is showing. `id` of 0 means the bare hand. */
  setHeld(id) {
    if (id === this.heldId) return;
    this.heldId = id;

    const block = BLOCKS[id];
    if (!block || id === 0) {
      this.cube.visible = false;
      this.cross.visible = false;
      this.arm.visible = true;
      return;
    }

    this.arm.visible = false;
    if (block.render === Render.CROSS) {
      this.cube.visible = false;
      this.cross.visible = true;
      this.cross.geometry.dispose();
      this.cross.geometry = buildCrossGeometry(block.tiles[2], 0.4);
    } else {
      this.cross.visible = false;
      this.cube.visible = true;
      setBoxLayers(this.cube.geometry, block.tiles);
    }
  }

  /** Start (or restart) the use animation. */
  swing() {
    this.swingTime = 0;
  }

  get swinging() {
    return this.swingTime >= 0;
  }

  resize(width, height) {
    // A zero-sized viewport is reported during window minimise and some
    // fullscreen transitions. Keeping the last good aspect ratio is what stops
    // a degenerate projection matrix from blanking the held item.
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width < 1 || height < 1) return;
    const aspect = width / height;
    if (aspect === this.camera.aspect) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param {number} delta
   * @param {object} state
   * @param {import('../entity/player.js').Player} state.player
   * @param {import('./sky.js').Sky} state.sky
   * @param {number} state.blockLight   0..1 torch light at the player
   * @param {number[]} state.tint       linear RGB multiplier for the held block
   */
  update(delta, { player, sky, blockLight = 0, brightness = 1, tint = null }) {
    applySkyToModel(this.material, sky, brightness);
    applySkyToModel(this.crossMaterial, sky, brightness);
    this.material.uniforms.uBlockLight.value = blockLight;
    this.crossMaterial.uniforms.uBlockLight.value = blockLight;

    const tintVector = this.material.uniforms.uTint.value;
    if (tint) tintVector.set(tint[0], tint[1], tint[2]);
    else tintVector.set(1, 1, 1);
    this.crossMaterial.uniforms.uTint.value.copy(tintVector);

    // Idle sway from the walk cycle, damped so it never fights the swing.
    const strength = player.bobStrength * 0.045;
    this.bob.set(
      Math.cos(player.bobPhase * 0.5) * strength * 1.4,
      -Math.abs(Math.sin(player.bobPhase)) * strength,
      0,
    );

    let swingX = 0;
    let swingY = 0;
    let swingRotation = 0;
    if (this.swingTime >= 0) {
      this.swingTime += delta;
      const t = this.swingTime / SWING_DURATION;
      if (t >= 1) {
        this.swingTime = -1;
      } else {
        // Down-and-back arc: fast out, slower recovery.
        const arc = Math.sin(t * Math.PI);
        swingY = -arc * 0.28;
        swingX = -arc * 0.14;
        swingRotation = arc * 0.9;
      }
    }

    // Looking up or down slides the model slightly, which sells the idea that
    // it is attached to a body rather than glued to the screen.
    const pitchOffset = player.pitch * 0.08;

    this.pivot.position.set(
      this.bob.x + swingX,
      this.bob.y + swingY + pitchOffset,
      0,
    );
    this.pivot.rotation.set(swingRotation * 0.55, swingRotation * 0.3, -swingRotation * 0.35);
  }

  /**
   * Composite over whatever is already in the frame buffer.
   *
   * The depth clear is the whole point of this pass, and it only works if
   * depth writing is enabled: `glClear(DEPTH_BUFFER_BIT)` is masked by the
   * depth write mask, and the world pass ends with a `depthWrite: false`
   * material. Without re-enabling it the clear does nothing and the held item
   * is depth-tested against the terrain — drawn, and invisible.
   */
  render(renderer) {
    if (!this.enabled) return;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.state.buffers.depth.setMask(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    this.cube.geometry.dispose();
    this.cross.geometry.dispose();
    this.arm.geometry.dispose();
    this.material.dispose();
    this.crossMaterial.dispose();
  }
}
