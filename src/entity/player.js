/**
 * The player: movement, collision, swimming, flight and survival state.
 *
 * Collision is axis-separated and sub-stepped rather than swept. Every solid
 * block in this world is a full cube, so resolving one axis at a time against
 * the block grid is exact — when a move ends inside a block, the contact plane
 * is known analytically and the position snaps straight to it. Sub-stepping
 * caps how far a single resolution can travel, which is what stops a fast fall
 * from tunnelling through a floor.
 *
 * Ordering matters: vertical first, then horizontal. Resolving Y first means
 * `onGround` is already correct when the horizontal pass decides whether it is
 * allowed to step up a block.
 */

import * as THREE from 'three';
import { AIR, WATER, LAVA, getBlock } from '../world/blocks.js';

const WIDTH = 0.6;
const HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const SNEAK_EYE_HEIGHT = 1.44;
const STEP_HEIGHT = 0.6;

/** Nudge used when snapping out of a block, so the next test does not re-hit. */
const SKIN = 1e-4;
/** Largest distance resolved in one collision pass. */
const MAX_SUBSTEP = 0.35;

const GRAVITY = 30;
const FLUID_GRAVITY = 7.5;
const TERMINAL_SPEED = 62;
const FLUID_TERMINAL_SPEED = 4.5;

const JUMP_SPEED = 8.6;
const SWIM_UP_SPEED = 4.2;

const WALK_SPEED = 4.4;
const SPRINT_SPEED = 6.1;
const SNEAK_SPEED = 1.45;
const SWIM_SPEED = 3.6;
const FLY_SPEED = 12;
const FLY_SPRINT_MULTIPLIER = 3.4;

const GROUND_ACCEL = 55;
const AIR_ACCEL = 11;
const FLUID_ACCEL = 16;
const FLY_ACCEL = 26;

const GROUND_DRAG = 13;
const AIR_DRAG = 0.7;
const FLUID_DRAG = 5.5;
const FLY_DRAG = 9;

/** Blocks of free fall tolerated before landing hurts. */
const SAFE_FALL = 3.5;
/** Seconds of breath underwater before drowning starts. */
const MAX_BREATH = 15;

const HALF_PI = Math.PI / 2 - 1e-4;

/**
 * Radians per second the view turns toward the stick at full deflection.
 *
 * About 100 degrees a second: fast enough that rounding a corner does not feel
 * like steering a ship, slow enough to read as the player turning rather than
 * the camera being snatched away.
 */
const MOVEMENT_TURN_RATE = 1.75;
/** Sideways push below which the stick counts as straight ahead. */
const TURN_DEADZONE = 0.12;

export const GameMode = {
  SURVIVAL: 'survival',
  CREATIVE: 'creative',
  SPECTATOR: 'spectator',
};

export const Perspective = {
  FIRST: 0,
  THIRD_BACK: 1,
  THIRD_FRONT: 2,
};

export class Player {
  /**
   * @param {object} options
   * @param {import('../world/world.js').World} options.world
   * @param {import('../core/input.js').Input} options.input
   * @param {import('../core/settings.js').Settings} options.settings
   */
  constructor({ world, input, settings }) {
    this.world = world;
    this.input = input;
    this.settings = settings;

    /** Feet position: the centre of the bottom face of the collision box. */
    this.position = new THREE.Vector3(0, 80, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.gameMode = GameMode.SURVIVAL;
    this.perspective = Perspective.FIRST;

    this.onGround = false;
    this.inWater = false;
    this.inLava = false;
    this.submerged = false;
    this.sneaking = false;
    this.sprinting = false;
    this.flying = false;

    this.health = 20;
    this.maxHealth = 20;
    this.breath = MAX_BREATH;
    this.dead = false;
    this.spawnPoint = new THREE.Vector3(0, 80, 0);

    this.fallDistance = 0;
    this.stepDistance = 0;
    this.bobPhase = 0;
    this.bobStrength = 0;
    /** Seconds of invulnerability left after taking a hit. */
    this.hurtCooldown = 0;
    this.hurtFlash = 0;
    this.lavaTimer = 0;
    this.drownTimer = 0;

    this._lastJumpPress = -1;
    this._wasJumpDown = false;

    /** Consumers hook these rather than the player polling them back. */
    this.onFootstep = null;
    this.onDamage = null;
    this.onDeath = null;
    this.onEnterFluid = null;

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._cameraTarget = new THREE.Vector3();
    this._cameraDirection = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._step = new THREE.Vector3();
    this._saved = new THREE.Vector3();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  get eyeHeight() {
    return this.sneaking && this.onGround ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
  }

  /** World-space eye position. Returns a shared vector. */
  getEyePosition() {
    return this._eye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Unit vector the player is looking along. Returns a shared vector. */
  getLookDirection(out = new THREE.Vector3()) {
    const cosPitch = Math.cos(this.pitch);
    return out.set(
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch,
    );
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.fallDistance = 0;
  }

  setGameMode(mode) {
    this.gameMode = mode;
    if (mode === GameMode.SURVIVAL) {
      this.flying = false;
    } else if (mode === GameMode.SPECTATOR) {
      this.flying = true;
    }
    if (mode !== GameMode.SURVIVAL) {
      this.health = this.maxHealth;
      this.breath = MAX_BREATH;
      this.dead = false;
    }
  }

  get noclip() {
    return this.gameMode === GameMode.SPECTATOR;
  }

  get invulnerable() {
    return this.gameMode !== GameMode.SURVIVAL;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(delta) {
    if (this.dead) {
      // A dead player still falls, so the death camera settles on the ground
      // rather than hanging where they were hit.
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * delta, -TERMINAL_SPEED);
      this.moveAndCollide(delta);
      this.hurtFlash = Math.max(0, this.hurtFlash - delta * 2);
      return;
    }

    this.applyLook(delta);
    this.sampleFluids();

    const input = this.input;
    const wantsSneak = input.isDown('sneak');
    this.sneaking = wantsSneak && !this.flying;

    this.handleFlightToggle(delta);

    if (this.flying) this.updateFlight(delta);
    else if (this.inWater || this.inLava) this.updateSwim(delta);
    else this.updateWalk(delta);

    this.moveAndCollide(delta);
    this.updateSurvival(delta);
    this.updateFootsteps(delta);

    this.hurtCooldown = Math.max(0, this.hurtCooldown - delta);
    this.hurtFlash = Math.max(0, this.hurtFlash - delta * 2.6);
  }

  applyLook(delta = 0) {
    if (!this.input.lookActive) return;
    const look = this.input.takeLook();
    this.yaw += look.yaw + this.movementTurn(delta);
    this.pitch = THREE.MathUtils.clamp(this.pitch + look.pitch, -HALF_PI, HALF_PI);
    // Keep yaw bounded so a long session cannot drift into float imprecision.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /**
   * True while the stick's sideways axis steers instead of sidestepping.
   *
   * A mouse turns you constantly, so on a desktop the way you face and the way
   * you walk are the same thing without anyone thinking about it. A thumbstick
   * alone never turns you: push it left and you sidestep left for as long as
   * you hold it, still facing where you started. Steering closes that gap —
   * push left and you turn left, push forward-left and you walk an arc into
   * the new heading, exactly as if you had dragged the view around.
   *
   * It stands down in the two cases where sidestepping is the better answer:
   *
   *   - A finger on the look surface. Two thumbs means the player is aiming
   *     with one and moving with the other, which is desktop controls; the
   *     stick must not also be turning the camera underneath them.
   *   - The stick pulled back. Walking backwards is deliberate, and spinning
   *     the view round to face the way you are retreating fights that.
   */
  get stickSteers() {
    if (!this.settings?.get('turnWithMovement')) return false;
    if (this.input.lookDragging) return false;
    const axis = this.input.moveAxis;
    if (!axis || (axis.x === 0 && axis.y === 0)) return false;
    return axis.y >= -0.25;
  }

  /** Yaw change from the stick this frame, in radians. */
  movementTurn(delta) {
    if (delta <= 0 || !this.stickSteers) return 0;

    const sideways = this.input.moveAxis.x;
    if (Math.abs(sideways) <= TURN_DEADZONE) return 0;

    // Rescaled past the deadzone, so a stick held slightly off centre while
    // running straight does not curve the path.
    const magnitude = (Math.abs(sideways) - TURN_DEADZONE) / (1 - TURN_DEADZONE);
    // The right vector is +x and increasing yaw turns left, so the sign is
    // inverted: a push to the right has to turn the player right.
    return -Math.sign(sideways) * magnitude * MOVEMENT_TURN_RATE * delta;
  }

  /** Read the blocks the body occupies to decide what it is standing in. */
  sampleFluids() {
    const wasInWater = this.inWater;
    const feet = this.world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y + 0.2),
      Math.floor(this.position.z),
    );
    const head = this.world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y + this.eyeHeight),
      Math.floor(this.position.z),
    );

    this.inWater = feet === WATER || head === WATER;
    this.inLava = feet === LAVA || head === LAVA;
    this.submerged = head === WATER;

    if (this.inWater && !wasInWater && this.velocity.y < -6) {
      this.onEnterFluid?.('water', this.position);
    }
  }

  /**
   * Double-tapping jump toggles flight in creative. The 300 ms window is short
   * enough that a rapid double jump while walking never triggers it by accident.
   */
  handleFlightToggle(delta) {
    void delta;
    const jumpDown = this.input.isDown('jump');
    const pressed = jumpDown && !this._wasJumpDown;
    this._wasJumpDown = jumpDown;

    if (!pressed || this.gameMode === GameMode.SURVIVAL) return;
    if (this.gameMode === GameMode.SPECTATOR) return;

    const now = performance.now();
    if (now - this._lastJumpPress < 300) {
      this.flying = !this.flying;
      if (this.flying) this.velocity.y = 0;
      this._lastJumpPress = -1;
      this.fallDistance = 0;
    } else {
      this._lastJumpPress = now;
    }
  }

  /**
   * Horizontal movement basis for the current yaw, flattened onto the ground.
   *
   * Keys and the analog stick both feed this. Only vectors longer than one are
   * normalised, so two keys still give the same speed as one while a stick
   * pushed halfway walks at half speed instead of snapping to a run.
   */
  buildWishDirection() {
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = this._wish.set(0, 0, 0);
    const input = this.input;
    if (input.isDown('forward')) wish.add(this._forward);
    if (input.isDown('back')) wish.sub(this._forward);
    if (input.isDown('right')) wish.add(this._right);
    if (input.isDown('left')) wish.sub(this._right);

    const axis = input.moveAxis;
    if (axis && (axis.x !== 0 || axis.y !== 0)) {
      wish.addScaledVector(this._forward, axis.y);
      // While the stick is steering, its sideways axis has already been spent
      // on the yaw. Letting it strafe as well would crab the player sideways
      // through their own turn.
      if (!this.stickSteers) wish.addScaledVector(this._right, axis.x);
    }

    if (wish.lengthSq() > 1) wish.normalize();
    return wish;
  }

  /** True while the player is asking to go forward, by key or by stick. */
  get forwardIntent() {
    return this.input.isDown('forward') || (this.input.moveAxis?.y ?? 0) > 0.4;
  }

  updateWalk(delta) {
    const wish = this.buildWishDirection();

    // Sprinting needs forward intent, so releasing W drops out of the sprint
    // rather than leaving the player gliding sideways at sprint speed.
    const wantsSprint = this.input.isDown('sprint') && this.forwardIntent && !this.sneaking;
    this.sprinting = wantsSprint && wish.lengthSq() > 0;

    const speed = this.sneaking ? SNEAK_SPEED : this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const drag = this.onGround ? GROUND_DRAG : AIR_DRAG;

    this.accelerateHorizontal(wish, speed, accel, drag, delta);

    if (this.input.isDown('jump') && this.onGround) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
      // A sprint jump carries a little extra momentum, which is what makes
      // sprint-jumping across gaps feel worth doing.
      if (this.sprinting) {
        this.velocity.x += this._forward.x * 1.6;
        this.velocity.z += this._forward.z * 1.6;
      }
    }

    this.velocity.y = Math.max(this.velocity.y - GRAVITY * delta, -TERMINAL_SPEED);
  }

  updateSwim(delta) {
    const wish = this.buildWishDirection();
    this.sprinting = false;

    const speed = this.inLava ? SWIM_SPEED * 0.45 : SWIM_SPEED;
    this.accelerateHorizontal(wish, speed, FLUID_ACCEL, FLUID_DRAG, delta);

    const gravity = this.inLava ? FLUID_GRAVITY * 0.6 : FLUID_GRAVITY;
    this.velocity.y = Math.max(this.velocity.y - gravity * delta, -FLUID_TERMINAL_SPEED);

    if (this.input.isDown('jump')) {
      const target = this.inLava ? SWIM_UP_SPEED * 0.5 : SWIM_UP_SPEED;
      this.velocity.y += (target - this.velocity.y) * Math.min(1, delta * 8);
    } else if (this.input.isDown('sneak')) {
      this.velocity.y -= FLUID_ACCEL * 0.35 * delta;
    } else if (!this.submerged && this.velocity.y < 0) {
      // Bob at the surface instead of sinking while treading water.
      this.velocity.y *= Math.max(0, 1 - delta * 6);
    }

    this.fallDistance = 0;
  }

  updateFlight(delta) {
    const wish = this.buildWishDirection();
    this.sprinting = this.input.isDown('sprint');

    const speed = FLY_SPEED * (this.sprinting ? FLY_SPRINT_MULTIPLIER : 1);
    this.accelerateHorizontal(wish, speed, FLY_ACCEL, FLY_DRAG, delta);

    let verticalTarget = 0;
    if (this.input.isDown('jump')) verticalTarget += speed * 0.8;
    if (this.input.isDown('sneak')) verticalTarget -= speed * 0.8;

    const blend = 1 - Math.exp(-FLY_ACCEL * delta);
    this.velocity.y += (verticalTarget - this.velocity.y) * blend;
    this.fallDistance = 0;
  }

  /**
   * Approach a target horizontal velocity.
   *
   * Acceleration toward the wish direction and drag against current motion are
   * applied separately, which is what gives air control that feels responsive
   * without letting the player change direction instantly at full speed.
   */
  accelerateHorizontal(wish, speed, accel, drag, delta) {
    const velocity = this.velocity;

    if (wish.lengthSq() > 0) {
      const targetX = wish.x * speed;
      const targetZ = wish.z * speed;
      const blend = 1 - Math.exp(-accel * delta);
      velocity.x += (targetX - velocity.x) * blend;
      velocity.z += (targetZ - velocity.z) * blend;
    } else {
      const decay = Math.exp(-drag * delta);
      velocity.x *= decay;
      velocity.z *= decay;
      if (Math.abs(velocity.x) < 1e-3) velocity.x = 0;
      if (Math.abs(velocity.z) < 1e-3) velocity.z = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  /** True if the block at these coordinates blocks movement. */
  isSolid(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return false;
    return this.world.tables.solid[id] === 1;
  }

  /** True if the body box at (x, y, z) overlaps any solid block. */
  collidesAt(x, y, z) {
    const half = WIDTH / 2;
    const minX = Math.floor(x - half + SKIN);
    const maxX = Math.floor(x + half - SKIN);
    const minY = Math.floor(y + SKIN);
    const maxY = Math.floor(y + HEIGHT - SKIN);
    const minZ = Math.floor(z - half + SKIN);
    const maxZ = Math.floor(z + half - SKIN);

    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        for (let bx = minX; bx <= maxX; bx++) {
          if (this.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Advance the position by the frame's velocity, resolving collisions.
   * Sets `onGround` and accumulates fall distance as a side effect.
   */
  moveAndCollide(delta) {
    const step = this._step.copy(this.velocity).multiplyScalar(delta);

    if (this.noclip) {
      this.position.add(step);
      this.onGround = false;
      return;
    }

    // Split into sub-steps no longer than a third of a block, so a fast mover
    // can never skip past a thin floor between two collision tests.
    const distance = step.length();
    const parts = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
    step.divideScalar(parts);

    const wasOnGround = this.onGround;
    this.onGround = false;

    for (let i = 0; i < parts; i++) {
      this.moveVertical(step.y);
      this.moveHorizontal(step.x, step.z, wasOnGround);
    }

    if (this.onGround) {
      if (this.fallDistance > 0) this.land();
    } else if (this.velocity.y < 0) {
      this.fallDistance -= this.velocity.y * delta;
    }
  }

  moveVertical(amount) {
    if (amount === 0) return;
    const next = this.position.y + amount;
    if (!this.collidesAt(this.position.x, next, this.position.z)) {
      this.position.y = next;
      return;
    }

    if (amount > 0) {
      // Head hit a ceiling: park just below it and kill upward momentum.
      this.position.y = Math.floor(next + HEIGHT) - HEIGHT - SKIN;
      if (this.velocity.y > 0) this.velocity.y = 0;
    } else {
      this.position.y = Math.floor(next) + 1 + SKIN;
      this.velocity.y = 0;
      this.onGround = true;
    }
  }

  moveHorizontal(dx, dz, wasOnGround) {
    const blockedX = dx !== 0 && !this.tryAxis('x', dx);
    const blockedZ = dz !== 0 && !this.tryAxis('z', dz);

    // Sneaking refuses any move that would leave the player unsupported, which
    // is the whole point of sneaking near an edge.
    if (this.sneaking && this.onGround) {
      this.preventLedgeFall(dx, dz);
    }

    if (!blockedX && !blockedZ) return;
    if (!(this.onGround || wasOnGround) || this.flying) return;

    // Blocked at foot level with headroom above: step up onto the ledge.
    if (blockedX) this.tryStep('x', dx);
    if (blockedZ) this.tryStep('z', dz);
  }

  /**
   * Move along one horizontal axis, snapping to the contact plane on a hit.
   * Returns true when the full move went through.
   */
  tryAxis(axis, amount) {
    const half = WIDTH / 2;
    const original = this.position[axis];
    const next = original + amount;

    const x = axis === 'x' ? next : this.position.x;
    const z = axis === 'z' ? next : this.position.z;
    if (!this.collidesAt(x, this.position.y, z)) {
      this.position[axis] = next;
      return true;
    }

    this.position[axis] = amount > 0
      ? Math.floor(next + half) - half - SKIN
      : Math.floor(next - half) + 1 + half + SKIN;
    this.velocity[axis] = 0;
    return false;
  }

  /**
   * Attempt a step up. Raises the body, retries the blocked move, then settles
   * back down; anything that does not land on solid ground is rolled back so a
   * failed step never leaves the player floating.
   */
  tryStep(axis, amount) {
    const saved = this._saved.copy(this.position);
    const savedVelocity = this.velocity[axis];

    const raised = this.position.y + STEP_HEIGHT;
    if (this.collidesAt(this.position.x, raised, this.position.z)) return;
    this.position.y = raised;

    this.velocity[axis] = savedVelocity;
    if (!this.tryAxis(axis, amount)) {
      this.position.copy(saved);
      this.velocity[axis] = 0;
      return;
    }

    // Settle onto whatever is under the new position.
    let drop = STEP_HEIGHT + SKIN;
    while (drop > 0) {
      const slice = Math.min(drop, MAX_SUBSTEP);
      const next = this.position.y - slice;
      if (this.collidesAt(this.position.x, next, this.position.z)) {
        this.position.y = Math.floor(next) + 1 + SKIN;
        this.onGround = true;
        this.velocity[axis] = savedVelocity;
        return;
      }
      this.position.y = next;
      drop -= slice;
    }

    // Nothing to stand on up there: it was a gap, not a step.
    this.position.copy(saved);
    this.velocity[axis] = 0;
  }

  /** Undo a horizontal move that would walk the player off a ledge. */
  preventLedgeFall(dx, dz) {
    if (this.supported(this.position.x, this.position.z)) return;

    if (dx !== 0 && this.supported(this.position.x - dx, this.position.z)) {
      this.position.x -= dx;
      this.velocity.x = 0;
      if (this.supported(this.position.x, this.position.z)) return;
    }
    if (dz !== 0 && this.supported(this.position.x, this.position.z - dz)) {
      this.position.z -= dz;
      this.velocity.z = 0;
    }
  }

  /** True if any block directly under the body box is solid. */
  supported(x, z) {
    const half = WIDTH / 2 - 0.02;
    const y = Math.floor(this.position.y - 0.05);
    for (const ox of [-half, half]) {
      for (const oz of [-half, half]) {
        if (this.isSolid(Math.floor(x + ox), y, Math.floor(z + oz))) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Survival
  // -------------------------------------------------------------------------

  land() {
    const distance = this.fallDistance;
    this.fallDistance = 0;
    if (distance < 0.6) return;

    this.onFootstep?.(this.groundMaterial(), Math.min(1, distance / 6) * 0.9 + 0.3, true);

    if (this.invulnerable || this.inWater || this.inLava) return;
    if (distance > SAFE_FALL) {
      this.damage(Math.floor(distance - SAFE_FALL) + 1, 'fall');
    }
  }

  updateSurvival(delta) {
    if (this.position.y < -8) {
      // Below the world: kill quickly rather than falling forever.
      this.damage(this.invulnerable ? 0 : 4, 'void');
      if (this.invulnerable) this.teleport(this.position.x, 140, this.position.z);
    }

    if (this.invulnerable) {
      this.breath = MAX_BREATH;
      return;
    }

    if (this.submerged) {
      this.breath -= delta;
      if (this.breath <= 0) {
        this.drownTimer += delta;
        if (this.drownTimer >= 1) {
          this.drownTimer = 0;
          this.damage(2, 'drown');
        }
      }
    } else {
      // Refills about three times faster than it drains.
      this.breath = Math.min(MAX_BREATH, this.breath + delta * 3);
      this.drownTimer = 0;
    }

    if (this.inLava) {
      this.lavaTimer += delta;
      if (this.lavaTimer >= 0.5) {
        this.lavaTimer = 0;
        this.damage(3, 'lava');
      }
    } else {
      this.lavaTimer = 0;
    }
  }

  damage(amount, cause = 'generic') {
    if (this.dead || amount <= 0) return;
    if (this.invulnerable && cause !== 'void') return;
    if (this.hurtCooldown > 0 && cause !== 'void') return;

    this.health = Math.max(0, this.health - amount);
    this.hurtCooldown = 0.45;
    this.hurtFlash = 1;
    this.onDamage?.(amount, cause);

    if (this.health <= 0) {
      this.dead = true;
      this.onDeath?.(cause);
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  respawn() {
    this.health = this.maxHealth;
    this.breath = MAX_BREATH;
    this.dead = false;
    this.hurtFlash = 0;
    this.fallDistance = 0;
    this.velocity.set(0, 0, 0);
    this.position.copy(this.spawnPoint);
    this.pitch = 0;
  }

  // -------------------------------------------------------------------------
  // Footsteps and view bob
  // -------------------------------------------------------------------------

  /** The `sound` group of the block being walked on. */
  groundMaterial() {
    const id = this.world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y - 0.2),
      Math.floor(this.position.z),
    );
    return getBlock(id).sound;
  }

  updateFootsteps(delta) {
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    // Bob strength trails the actual speed so it eases in and out of a stop.
    const targetBob = this.onGround && !this.flying ? Math.min(1, horizontalSpeed / WALK_SPEED) : 0;
    this.bobStrength += (targetBob - this.bobStrength) * Math.min(1, delta * 9);
    this.bobPhase += horizontalSpeed * delta * 2.1;

    if (!this.onGround || this.flying || horizontalSpeed < 0.6) return;

    this.stepDistance += horizontalSpeed * delta;
    const stride = this.sprinting ? 2.4 : 2.0;
    if (this.stepDistance < stride) return;
    this.stepDistance = 0;

    if (this.inWater) this.onEnterFluid?.('swim', this.position);
    else this.onFootstep?.(this.groundMaterial(), this.sneaking ? 0.35 : 1, false);
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  /**
   * Drive the render camera from player state.
   *
   * Third person pulls back along the view ray and stops short of anything
   * solid, so the camera never ends up inside a wall looking at black.
   */
  updateCamera(camera, delta) {
    const eye = this.getEyePosition();
    this._cameraTarget.copy(eye);

    if (this.settings?.get('viewBobbing') && this.perspective === Perspective.FIRST) {
      const strength = this.bobStrength * 0.055;
      this._cameraTarget.y += Math.abs(Math.sin(this.bobPhase)) * strength;
      // The lateral component runs at half the vertical frequency, which is
      // what makes it read as alternating footfalls rather than a wobble.
      this._cameraTarget.x += Math.cos(this.bobPhase * 0.5) * strength * 0.6 * Math.cos(this.yaw);
      this._cameraTarget.z -= Math.cos(this.bobPhase * 0.5) * strength * 0.6 * Math.sin(this.yaw);
    }

    if (this.dead) {
      // Fall to the ground and look up at the sky.
      this._cameraTarget.y = this.position.y + 0.35;
      camera.rotation.set(THREE.MathUtils.clamp(this.pitch, -0.4, 0.4), this.yaw, 0.6, 'YXZ');
    } else {
      camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    }

    if (this.perspective !== Perspective.FIRST) {
      const back = this.perspective === Perspective.THIRD_BACK ? 1 : -1;
      const direction = this.getLookDirection(this._cameraDirection).multiplyScalar(-back);
      const distance = this.cameraClearance(this._cameraTarget, direction, 4.2);
      this._cameraTarget.addScaledVector(direction, distance);
      if (this.perspective === Perspective.THIRD_FRONT) {
        camera.rotation.set(-this.pitch, this.yaw + Math.PI, 0, 'YXZ');
      }
    }

    // A short smoothing window hides the single-frame jump that a step-up or a
    // teleport would otherwise put in the view.
    const blend = delta > 0 ? 1 - Math.exp(-32 * delta) : 1;
    camera.position.lerp(this._cameraTarget, this.perspective === Perspective.FIRST ? blend : 1);
  }

  /** How far the third-person camera can pull back before hitting geometry. */
  cameraClearance(origin, direction, maxDistance) {
    const probe = this._probe;
    const stepSize = 0.2;
    for (let travelled = stepSize; travelled <= maxDistance; travelled += stepSize) {
      probe.copy(origin).addScaledVector(direction, travelled);
      if (this.isSolid(Math.floor(probe.x), Math.floor(probe.y), Math.floor(probe.z))) {
        return Math.max(0.4, travelled - stepSize * 2);
      }
    }
    return maxDistance;
  }

  cyclePerspective() {
    this.perspective = (this.perspective + 1) % 3;
    return this.perspective;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  serialize() {
    return {
      position: [this.position.x, this.position.y, this.position.z],
      spawn: [this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z],
      yaw: this.yaw,
      pitch: this.pitch,
      gameMode: this.gameMode,
      flying: this.flying,
      health: this.health,
      breath: this.breath,
    };
  }

  load(data) {
    if (!data) return;
    // Every field is validated rather than trusted. A save written from a
    // session that went wrong can hold a NaN, and loading one straight into the
    // position would put the camera somewhere that cannot be rendered — the
    // world would come back black and stay that way.
    if (isVectorArray(data.position)) this.position.fromArray(data.position);
    if (isVectorArray(data.spawn)) this.spawnPoint.fromArray(data.spawn);
    if (Number.isFinite(data.yaw)) this.yaw = data.yaw;
    if (Number.isFinite(data.pitch)) this.pitch = THREE.MathUtils.clamp(data.pitch, -HALF_PI, HALF_PI);
    if (data.gameMode) this.setGameMode(data.gameMode);
    if (typeof data.flying === 'boolean') this.flying = data.flying;
    if (Number.isFinite(data.health)) this.health = THREE.MathUtils.clamp(data.health, 0, this.maxHealth);
    if (Number.isFinite(data.breath)) this.breath = THREE.MathUtils.clamp(data.breath, 0, MAX_BREATH);
    this.velocity.set(0, 0, 0);
    this.dead = this.health <= 0;
  }

  /**
   * Repair state that can no longer be rendered or simulated.
   *
   * Physics has no legitimate way to produce a non-finite position, but a
   * corrupt save, a bad teleport or an arithmetic edge case would all end the
   * same way: the camera follows the player, the projection turns to NaN, and
   * every frame after that culls the entire world including the sky. Rather
   * than trust that it can never happen, check once a frame and put the player
   * back somewhere real. Returns true when something had to be repaired.
   */
  sanitize() {
    let repaired = false;

    if (!Number.isFinite(this.yaw)) { this.yaw = 0; repaired = true; }
    if (!Number.isFinite(this.pitch)) { this.pitch = 0; repaired = true; }

    if (!isFiniteVector(this.velocity)) {
      this.velocity.set(0, 0, 0);
      repaired = true;
    }

    if (!isFiniteVector(this.position)) {
      const fallback = isFiniteVector(this.spawnPoint) ? this.spawnPoint : null;
      if (fallback) this.position.copy(fallback);
      else this.position.set(0.5, 96, 0.5);
      this.velocity.set(0, 0, 0);
      this.fallDistance = 0;
      this.onGround = false;
      repaired = true;
    }

    if (!Number.isFinite(this.fallDistance)) { this.fallDistance = 0; repaired = true; }
    if (!Number.isFinite(this.bobPhase)) { this.bobPhase = 0; repaired = true; }
    if (!Number.isFinite(this.bobStrength)) { this.bobStrength = 0; repaired = true; }
    if (!Number.isFinite(this.health)) { this.health = this.maxHealth; repaired = true; }
    if (!Number.isFinite(this.breath)) { this.breath = MAX_BREATH; repaired = true; }

    return repaired;
  }
}

export const PLAYER_SIZE = { width: WIDTH, height: HEIGHT, eyeHeight: EYE_HEIGHT };

function isFiniteVector(vector) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isVectorArray(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite);
}
