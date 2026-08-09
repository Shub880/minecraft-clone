/**
 * First-person view model: your arm, and whatever it is holding.
 *
 * Drawn into its own scene with its own camera and composited over the world
 * with the depth buffer cleared. That is the only reliable way to keep a held
 * object out of the terrain: at a 0.08 near plane, a model placed in the world
 * scene close enough to fill the corner of the screen will clip through
 * anything the player stands next to.
 *
 * The arm stays visible whatever you are holding. A block floating unsupported
 * in the corner of the screen is the single clearest tell that a voxel game is
 * not Minecraft, and it costs one extra box to fix: the item is parented to
 * the hand, so the two can never disagree about where the fist is.
 *
 * Every animation here is procedural and follows the shape of Minecraft's own:
 *
 *   swing   a square-root-eased arc — fast out, slower back — that dips toward
 *           the screen at the moment of impact
 *   equip   the hand drops out of frame, swaps what it holds at the bottom of
 *           the dip, and lifts the new item back up
 *   sway    a damped lag behind the camera, so whipping the view round throws
 *           the hand wide before it settles
 *   bob     the walk cycle, driven by the same phase as the camera's own bob
 */

import * as THREE from 'three';
import { BLOCKS, Render } from '../world/blocks.js';
import {
  buildBoxGeometry, buildCrossGeometry, createModelMaterial, applySkyToModel, setBoxLayers,
} from './model.js';

/** Seconds for one full swing. Minecraft's is six ticks. */
const SWING_DURATION = 0.3;
/** Seconds for a full lower-and-raise when the held item changes. */
const EQUIP_DURATION = 0.26;

/**
 * Resting placement of the hand, in view space.
 *
 * Distance is doing the work rather than scale: at this field of view the
 * visible half-height at z is 0.55z, so pushing the hand back to about one and
 * a third units is what keeps a held block to roughly a quarter of the screen
 * instead of a third of the viewport.
 */
const HAND_REST = new THREE.Vector3(0.44, -0.4, -1.0);
/** Empty hand sits a little closer in and further round, as Minecraft's does. */
const EMPTY_REST = new THREE.Vector3(0.36, -0.24, -0.78);

const BLOCK_SIZE = 0.24;
/** Cross-shaped items (plants, torches) are drawn taller and thinner. */
const CROSS_SIZE = 0.34;

const ARM_LENGTH = 0.62;
const ARM_THICKNESS = 0.115;

/**
 * Arm angles, in radians.
 *
 * The forearm runs down, out to the right and slightly away from the camera,
 * so it leaves the frame at the bottom-right corner instead of pointing at the
 * lens. Tilting it away rather than toward the viewer is the whole difference
 * between an arm and a stump.
 */
const ARM_HOLDING = [0.35, 0.16, -0.62];
const ARM_EMPTY = [0.42, 0.2, -0.95];

export class ViewModel {
  /**
   * @param {{texture: THREE.DataArrayTexture, tileIndexByName: Map<string, number>}} atlas
   */
  constructor(atlas) {
    this.atlas = atlas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.01, 12);

    this.material = createModelMaterial(atlas.texture);
    // Plants are drawn double sided and genuinely cut out, like in the world.
    this.crossMaterial = createModelMaterial(atlas.texture, { cutout: true });
    this.crossMaterial.side = THREE.DoubleSide;

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    // Everything the hand carries hangs off this, so the item can never drift
    // away from the fist holding it.
    this.hand = new THREE.Group();
    this.hand.position.copy(HAND_REST);
    this.pivot.add(this.hand);

    // The arm is built hanging from its wrist, then swung down and out to the
    // corner of the screen so the fist sits under the crosshair rather than
    // beside it.
    const armLayer = atlas.tileIndexByName.get('skin_arm_fp') ?? 0;
    const armGeometry = buildBoxGeometry(
      ARM_THICKNESS, ARM_LENGTH, ARM_THICKNESS, new Array(6).fill(armLayer),
    );
    armGeometry.translate(0, -ARM_LENGTH, 0);
    this.arm = new THREE.Mesh(armGeometry, this.material);
    this.arm.rotation.set(...ARM_HOLDING);
    this.hand.add(this.arm);

    // Cube for ordinary blocks. Layers are rewritten in place on every change,
    // so switching hotbar slots never allocates.
    this.cube = new THREE.Mesh(
      buildBoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE, [0, 0, 0, 0, 0, 0]),
      this.material,
    );
    this.cube.position.set(0.01, 0.02, -0.04);
    this.cube.rotation.set(0.2, -0.62, 0.06);
    this.hand.add(this.cube);

    // Cross geometry is rebuilt on change; plants are rare enough in the hand
    // that a small allocation on switch is cheaper than keeping six variants.
    this.cross = new THREE.Mesh(buildCrossGeometry(0, CROSS_SIZE), this.crossMaterial);
    this.cross.position.set(0.01, -0.14, -0.02);
    this.cross.rotation.set(0, -0.5, 0.14);
    this.cross.visible = false;
    this.hand.add(this.cross);

    this.heldId = -1;
    /** What the hand will be holding once the equip dip reaches the bottom. */
    this.pendingId = 0;
    this.swingTime = -1;
    this.equipTime = -1;

    this.bob = new THREE.Vector3();
    /** Damped lag behind the camera, which is what reads as weight. */
    this.sway = new THREE.Vector2();
    this._lastYaw = null;
    this._lastPitch = 0;
    this.enabled = true;

    this.applyHeld(0);
  }

  /**
   * Choose which model is showing. `id` of 0 means the bare hand.
   *
   * The change is deferred to the bottom of an equip dip so the swap happens
   * off screen — Minecraft's hand never mutates in place, it lowers what it
   * was holding and raises the new thing.
   */
  setHeld(id) {
    if (id === this.pendingId) return;
    this.pendingId = id;
    if (this.heldId === -1) {
      this.applyHeld(id);
      return;
    }
    this.equipTime = 0;
  }

  /** Swap the visible model immediately. */
  applyHeld(id) {
    this.heldId = id;
    this.pendingId = id;

    const block = BLOCKS[id];
    if (!block || id === 0) {
      this.cube.visible = false;
      this.cross.visible = false;
      this.hand.position.copy(EMPTY_REST);
      // An empty hand is raised further into frame and held straighter, the
      // way Minecraft shows a bare fist.
      this.arm.rotation.set(...ARM_EMPTY);
      return;
    }

    this.hand.position.copy(HAND_REST);
    this.arm.rotation.set(...ARM_HOLDING);

    if (block.render === Render.CROSS) {
      this.cube.visible = false;
      this.cross.visible = true;
      this.cross.geometry.dispose();
      this.cross.geometry = buildCrossGeometry(block.tiles[2], CROSS_SIZE);
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

    const swing = this.updateSwing(delta);
    const equip = this.updateEquip(delta);
    this.updateSway(delta, player);

    // Looking up or down slides the model slightly, which sells the idea that
    // it is attached to a body rather than glued to the screen.
    const pitchOffset = player.pitch * 0.07;
    // Sneaking tucks the hand down and rolls it away, as it does in Minecraft.
    const sneak = player.sneaking ? 1 : 0;

    this.pivot.position.set(
      this.bob.x + swing.x + this.sway.x,
      this.bob.y + swing.y + pitchOffset + this.sway.y - equip * 0.55 - sneak * 0.12,
      swing.z,
    );
    this.pivot.rotation.set(
      swing.rotX - this.sway.y * 1.6 + sneak * 0.25,
      swing.rotY + this.sway.x * 1.2,
      swing.rotZ - sneak * 0.2,
    );
  }

  /**
   * Advance the swing and return this frame's offset.
   *
   * The square root on the way in is what gives the arc its bite: the hand
   * leaves fast and returns slowly, so a click reads as a strike rather than a
   * wobble. The z term dips the item toward the camera at the midpoint, which
   * is the moment the blow lands.
   */
  updateSwing(delta) {
    const out = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
    if (this.swingTime < 0) return out;

    this.swingTime += delta;
    const t = this.swingTime / SWING_DURATION;
    if (t >= 1) {
      this.swingTime = -1;
      return out;
    }

    const eased = Math.sqrt(t);
    const arc = Math.sin(eased * Math.PI);

    out.x = -arc * 0.26;
    out.y = Math.sin(eased * Math.PI * 2) * 0.16;
    out.z = -Math.sin(t * Math.PI) * 0.18;
    out.rotX = -arc * 0.85;
    out.rotY = -arc * 0.32;
    out.rotZ = -Math.sin(t * t * Math.PI) * 0.45;
    return out;
  }

  /**
   * Advance the equip dip and return how far down the hand is, 0..1.
   * The model swaps at the bottom, where nothing is on screen to see it.
   */
  updateEquip(delta) {
    if (this.equipTime < 0) {
      // Nothing running, but the item may have been changed while one was:
      // catch up rather than holding the wrong thing forever.
      if (this.pendingId !== this.heldId) this.applyHeld(this.pendingId);
      return 0;
    }

    this.equipTime += delta;
    const t = this.equipTime / EQUIP_DURATION;
    if (t >= 1) {
      this.equipTime = -1;
      this.applyHeld(this.pendingId);
      return 0;
    }

    if (t >= 0.5 && this.heldId !== this.pendingId) this.applyHeld(this.pendingId);
    // A triangle wave: all the way down at the halfway point, back up by the
    // end. Squaring it makes the bottom of the dip linger a little.
    return 1 - Math.abs(t * 2 - 1) ** 1.4;
  }

  /**
   * Lag the hand behind the camera.
   *
   * Turning fast should throw the arm wide and let it settle, the way a real
   * hand carrying something does. The delta is clamped because a frame hitch
   * would otherwise register as an enormous turn and fling the model off
   * screen for a frame.
   */
  updateSway(delta, player) {
    if (this._lastYaw === null) {
      this._lastYaw = player.yaw;
      this._lastPitch = player.pitch;
    }

    let dYaw = player.yaw - this._lastYaw;
    // Yaw wraps at +/-PI; without this a single wrap looks like a full spin.
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = player.pitch - this._lastPitch;
    this._lastYaw = player.yaw;
    this._lastPitch = player.pitch;

    const targetX = THREE.MathUtils.clamp(dYaw * 0.6, -0.09, 0.09);
    const targetY = THREE.MathUtils.clamp(-dPitch * 0.6, -0.09, 0.09);

    // Spring toward the target, then decay back to centre.
    const blend = 1 - Math.exp(-18 * delta);
    this.sway.x += (targetX - this.sway.x) * blend;
    this.sway.y += (targetY - this.sway.y) * blend;
    const decay = Math.exp(-7 * delta);
    this.sway.x *= decay;
    this.sway.y *= decay;
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
