/**
 * Free-flight camera.
 *
 * Used for creative-mode flight and, later, for the slow orbit behind the
 * title screen. Movement is smoothed rather than instant, which is most of why
 * flying feels weighty instead of like dragging a cursor.
 */

import * as THREE from 'three';

const HALF_PI = Math.PI / 2 - 0.0001;

export class FlyCamera {
  constructor(camera, input) {
    this.camera = camera;
    this.input = input;

    this.yaw = 0;
    this.pitch = 0;

    this.velocity = new THREE.Vector3();
    this.baseSpeed = 14;
    this.sprintMultiplier = 3.2;
    this.acceleration = 12;
    this.damping = 9;

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
  }

  /** Point the camera at a yaw/pitch without moving it. */
  setLook(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, -HALF_PI, HALF_PI);
    this.applyRotation();
  }

  applyRotation() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  update(delta) {
    const input = this.input;

    if (input.locked) {
      const look = input.takeLook();
      this.yaw += look.yaw;
      this.pitch = THREE.MathUtils.clamp(this.pitch + look.pitch, -HALF_PI, HALF_PI);
      this.applyRotation();
    }

    // Movement basis, flattened so looking down does not slow forward travel.
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this._wish.set(0, 0, 0);
    if (input.isDown('forward')) this._wish.add(this._forward);
    if (input.isDown('back')) this._wish.sub(this._forward);
    if (input.isDown('right')) this._wish.add(this._right);
    if (input.isDown('left')) this._wish.sub(this._right);
    if (input.isDown('jump')) this._wish.y += 1;
    if (input.isDown('sneak')) this._wish.y -= 1;

    if (this._wish.lengthSq() > 0) this._wish.normalize();

    const speed = this.baseSpeed * (input.isDown('sprint') ? this.sprintMultiplier : 1);
    const target = this._wish.multiplyScalar(speed);

    // Exponential approach: reaches the target quickly but never snaps.
    const blend = 1 - Math.exp(-this.acceleration * delta);
    this.velocity.lerp(target, blend);
    if (this.velocity.lengthSq() < 1e-6) this.velocity.set(0, 0, 0);

    this.camera.position.addScaledVector(this.velocity, delta);
  }
}
