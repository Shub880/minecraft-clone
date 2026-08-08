/**
 * Block selection outline and break-progress overlay.
 *
 * Two objects that share one target position: a wireframe box around the block
 * under the crosshair, and a cracked-texture cube that appears while mining.
 *
 * Both are inflated a fraction past the block they surround. That is deliberate
 * rather than a hack: coincident coplanar surfaces z-fight, and a depth bias
 * alone does not survive the depth precision at the far end of a 1400-block
 * view. A 0.5% inflation is invisible at arm's length and unambiguous at depth.
 */

import * as THREE from 'three';
import { buildCrackTextures } from './atlas.js';

const OUTLINE_SCALE = 1.012;
const CRACK_SCALE = 1.006;

export class BlockHighlight {
  constructor(scene) {
    this.scene = scene;
    this.visible = false;
    this.stages = buildCrackTextures(8);

    const box = new THREE.BoxGeometry(OUTLINE_SCALE, OUTLINE_SCALE, OUTLINE_SCALE);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
        depthTest: true,
      }),
    );
    box.dispose();
    this.outline.visible = false;
    this.outline.renderOrder = 4;
    this.outline.frustumCulled = false;
    scene.add(this.outline);

    this.crackMaterial = new THREE.MeshBasicMaterial({
      map: this.stages[0],
      transparent: true,
      depthWrite: false,
      // Pull the overlay toward the camera so it wins against the block face
      // it is drawn on even where the inflation is not quite enough.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    this.cracks = new THREE.Mesh(
      new THREE.BoxGeometry(CRACK_SCALE, CRACK_SCALE, CRACK_SCALE),
      this.crackMaterial,
    );
    this.cracks.visible = false;
    this.cracks.renderOrder = 5;
    this.cracks.frustumCulled = false;
    scene.add(this.cracks);
  }

  /** Place the outline on a block, given its integer coordinates. */
  setTarget(x, y, z) {
    this.visible = true;
    this.outline.visible = true;
    this.outline.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.cracks.position.copy(this.outline.position);
  }

  hide() {
    this.visible = false;
    this.outline.visible = false;
    this.cracks.visible = false;
  }

  /**
   * Show mining damage. `progress` is 0..1; anything at or below zero hides the
   * overlay entirely rather than drawing an empty first stage.
   */
  setProgress(progress) {
    if (progress <= 0 || !this.visible) {
      this.cracks.visible = false;
      return;
    }
    const stage = Math.min(this.stages.length - 1, Math.floor(progress * this.stages.length));
    if (this.crackMaterial.map !== this.stages[stage]) {
      this.crackMaterial.map = this.stages[stage];
      this.crackMaterial.needsUpdate = true;
    }
    this.cracks.visible = true;
  }

  dispose() {
    this.scene.remove(this.outline);
    this.scene.remove(this.cracks);
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.cracks.geometry.dispose();
    this.crackMaterial.dispose();
    for (const texture of this.stages) texture.dispose();
  }
}
