/**
 * Third-person player avatar.
 *
 * Six boxes with the skin layers of the block atlas, animated procedurally: the
 * limbs swing from the same walk phase that drives view bobbing, so the body
 * and the camera agree about which foot is down.
 *
 * Limb geometry is translated so its origin sits at the joint rather than the
 * base of the box. Rotating a mesh whose origin is at its foot would swing the
 * leg around the ankle; moving the origin to the hip is what makes a rotation
 * read as a stride.
 */

import * as THREE from 'three';
import {
  buildBoxGeometry, buildCrossGeometry, createModelMaterial, applySkyToModel, setBoxLayers,
} from '../render/model.js';
import { BLOCKS, Render } from '../world/blocks.js';
import { Perspective } from './player.js';

const HEAD = 0.5;
const BODY_HEIGHT = 0.75;
const LIMB_THICKNESS = 0.24;
const ARM_LENGTH = 0.75;
const LEG_LENGTH = 0.55;

const HIP_Y = LEG_LENGTH;
const SHOULDER_Y = HIP_Y + BODY_HEIGHT;

/** Held block size on the avatar, roughly a third of a world block. */
const HELD_SIZE = 0.34;

export class PlayerModel {
  /**
   * @param {THREE.Scene} scene
   * @param {{texture: THREE.DataArrayTexture, tileIndexByName: Map<string, number>}} atlas
   */
  constructor(scene, atlas) {
    this.scene = scene;
    this.material = createModelMaterial(atlas.texture);

    const layer = (name) => atlas.tileIndexByName.get(name) ?? 0;
    const face = layer('skin_face');
    const head = layer('skin_head');
    const hair = layer('skin_hair');
    const body = layer('skin_body');
    const arm = layer('skin_arm');
    const leg = layer('skin_leg');

    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    // Face order is +X, -X, +Y, -Y, +Z, -Z. The avatar faces -Z at yaw 0,
    // matching the player's forward vector, so the face goes on index 5.
    this.head = this.makePart(HEAD, HEAD, HEAD, [head, head, hair, head, head, face], 0);
    this.head.position.y = SHOULDER_Y;
    this.group.add(this.head);

    this.body = this.makePart(0.5, BODY_HEIGHT, 0.26, new Array(6).fill(body), 0);
    this.body.position.y = HIP_Y;
    this.group.add(this.body);

    this.leftArm = this.makePart(LIMB_THICKNESS, ARM_LENGTH, LIMB_THICKNESS, new Array(6).fill(arm), ARM_LENGTH);
    this.leftArm.position.set(-0.37, SHOULDER_Y, 0);
    this.group.add(this.leftArm);

    this.rightArm = this.makePart(LIMB_THICKNESS, ARM_LENGTH, LIMB_THICKNESS, new Array(6).fill(arm), ARM_LENGTH);
    this.rightArm.position.set(0.37, SHOULDER_Y, 0);
    this.group.add(this.rightArm);

    this.leftLeg = this.makePart(LIMB_THICKNESS, LEG_LENGTH, LIMB_THICKNESS, new Array(6).fill(leg), LEG_LENGTH);
    this.leftLeg.position.set(-0.12, HIP_Y, 0);
    this.group.add(this.leftLeg);

    this.rightLeg = this.makePart(LIMB_THICKNESS, LEG_LENGTH, LIMB_THICKNESS, new Array(6).fill(leg), LEG_LENGTH);
    this.rightLeg.position.set(0.12, HIP_Y, 0);
    this.group.add(this.rightLeg);

    // The held block is parented to the right arm so it swings with it. In
    // third person the arm is the only thing telling another player what you
    // are about to place, so an empty fist there would be a lie.
    this.cutoutMaterial = createModelMaterial(atlas.texture, { cutout: true });
    this.cutoutMaterial.side = THREE.DoubleSide;

    this.held = new THREE.Mesh(
      buildBoxGeometry(HELD_SIZE, HELD_SIZE, HELD_SIZE, [0, 0, 0, 0, 0, 0]),
      this.material,
    );
    this.held.position.set(0, -ARM_LENGTH - HELD_SIZE * 0.35, -HELD_SIZE * 0.4);
    this.held.rotation.set(0.2, 0.4, 0);
    this.held.frustumCulled = false;
    this.held.visible = false;
    this.rightArm.add(this.held);

    this.heldCross = new THREE.Mesh(buildCrossGeometry(0, 0.42), this.cutoutMaterial);
    this.heldCross.position.set(0, -ARM_LENGTH - 0.3, -0.08);
    this.heldCross.frustumCulled = false;
    this.heldCross.visible = false;
    this.rightArm.add(this.heldCross);

    this.heldId = -1;
    this.swingTime = -1;
  }

  /** Show the block the player is carrying. `id` of 0 is an empty hand. */
  setHeld(id) {
    if (id === this.heldId) return;
    this.heldId = id;

    const block = BLOCKS[id];
    if (!block || id === 0) {
      this.held.visible = false;
      this.heldCross.visible = false;
      return;
    }
    if (block.render === Render.CROSS) {
      this.held.visible = false;
      this.heldCross.visible = true;
      this.heldCross.geometry.dispose();
      this.heldCross.geometry = buildCrossGeometry(block.tiles[2], 0.42);
    } else {
      this.heldCross.visible = false;
      this.held.visible = true;
      setBoxLayers(this.held.geometry, block.tiles);
    }
  }

  /** `pivotOffset` shifts the geometry down so the mesh rotates about its top. */
  makePart(width, height, depth, layers, pivotOffset) {
    const geometry = buildBoxGeometry(width, height, depth, layers);
    if (pivotOffset) geometry.translate(0, -pivotOffset, 0);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Play the arm-swing animation, mirroring the first-person view model. */
  swing() {
    this.swingTime = 0;
  }

  /**
   * @param {number} delta
   * @param {import('./player.js').Player} player
   * @param {import('../render/sky.js').Sky} sky
   */
  update(delta, player, sky, { blockLight = 0, brightness = 1, cameraDistance = Infinity } = {}) {
    // In a tight space the third-person camera cannot pull back far enough to
    // clear the body, and the player ends up looking at the inside of their own
    // head. Hiding the model is better than showing them that.
    this.group.visible = player.perspective !== Perspective.FIRST && cameraDistance > 1.2;
    if (!this.group.visible) return;

    applySkyToModel(this.material, sky, brightness);
    applySkyToModel(this.cutoutMaterial, sky, brightness);
    this.material.uniforms.uBlockLight.value = blockLight;
    this.cutoutMaterial.uniforms.uBlockLight.value = blockLight;

    this.group.position.copy(player.position);
    this.group.rotation.y = player.yaw;

    this.head.rotation.x = THREE.MathUtils.clamp(player.pitch, -1.2, 1.2);

    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    // Amplitude tracks speed so a slow walk is a small stride and a sprint is
    // a full one, instead of everything animating at one fixed swing.
    const amplitude = Math.min(0.85, speed / 5.5);
    const phase = player.bobPhase;
    const swing = Math.sin(phase) * amplitude;

    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.85;
    this.rightArm.rotation.x = swing * 0.85;
    // Arms drift outward with the stride so they do not clip the body.
    this.leftArm.rotation.z = 0.06 + Math.abs(swing) * 0.06;
    this.rightArm.rotation.z = -0.06 - Math.abs(swing) * 0.06;

    if (player.flying || (!player.onGround && !player.inWater)) {
      // In the air the legs part and the arms lift, so a jump is legible.
      this.leftLeg.rotation.x = -0.4;
      this.rightLeg.rotation.x = 0.4;
      this.leftArm.rotation.x = -0.7;
      this.rightArm.rotation.x = -0.7;
    }

    if (player.sneaking) {
      this.body.rotation.x = 0.42;
      this.head.position.y = SHOULDER_Y - 0.18;
      this.leftArm.position.y = SHOULDER_Y - 0.14;
      this.rightArm.position.y = SHOULDER_Y - 0.14;
    } else {
      this.body.rotation.x = 0;
      this.head.position.y = SHOULDER_Y;
      this.leftArm.position.y = SHOULDER_Y;
      this.rightArm.position.y = SHOULDER_Y;
    }

    if (this.swingTime >= 0) {
      this.swingTime += delta;
      const t = this.swingTime / 0.3;
      if (t >= 1) {
        this.swingTime = -1;
      } else {
        this.rightArm.rotation.x = -Math.sin(t * Math.PI) * 2.2 - 0.2;
      }
    }
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    this.scene.remove(this.group);
    const parts = [
      this.head, this.body, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg,
      this.held, this.heldCross,
    ];
    for (const part of parts) part.geometry.dispose();
    this.material.dispose();
    this.cutoutMaterial.dispose();
  }
}
