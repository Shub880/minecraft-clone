/**
 * A single animal: physics, and the small amount of mind it needs.
 *
 * Collision resolves one axis at a time against the block grid, the same way
 * the player does, because every solid block here is a full cube and that
 * makes the contact plane exact. What differs is intent: an animal is not
 * being driven, so the interesting part is what it decides to do — wander,
 * stand and look around, bolt when hurt — and the rules that stop it doing
 * something stupid, like walking off a cliff or into a lake.
 */

import * as THREE from 'three';
import { AIR, WATER, LAVA } from '../world/blocks.js';

const GRAVITY = 26;
const TERMINAL_SPEED = 40;
const JUMP_SPEED = 7.4;

const GROUND_ACCEL = 14;
const AIR_ACCEL = 3;
const GROUND_DRAG = 9;
const AIR_DRAG = 0.6;

const SKIN = 1e-4;
const MAX_SUBSTEP = 0.3;

/** Blocks of free fall an animal shrugs off. */
const SAFE_FALL = 3.5;

/** Seconds of invulnerability after a hit, so one swing is one hit. */
const HURT_COOLDOWN = 0.4;
/** Seconds the body lies there before it is removed. */
const DEATH_DURATION = 0.9;

export const MobState = {
  IDLE: 0,
  WALK: 1,
  PANIC: 2,
};

export class Mob {
  /**
   * @param {import('./mob-species.js').SPECIES[string]} species
   * @param {number} x  feet position
   * @param {number} y
   * @param {number} z
   * @param {() => number} rand
   */
  constructor(species, x, y, z, rand) {
    this.species = species;
    this.position = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3();

    this.yaw = rand() * Math.PI * 2;
    /** Where the head is pointing, relative to the body. */
    this.headYaw = 0;
    this.headPitch = 0;

    this.onGround = false;
    this.inWater = false;
    this.dead = false;
    this.removed = false;

    this.health = species.health;
    this.maxHealth = species.health;
    this.hurtCooldown = 0;
    this.hurtFlash = 0;
    this.deathTimer = 0;
    this.fallDistance = 0;

    /** Distance walked, which drives the leg swing. */
    this.walkPhase = rand() * Math.PI * 2;
    /** Smoothed 0..1 stride amplitude, so starting and stopping ease. */
    this.walkAmount = 0;
    this.wingPhase = rand() * Math.PI * 2;

    this.state = MobState.IDLE;
    this.stateTimer = rand() * 3;
    this.targetYaw = this.yaw;
    this.voiceTimer = 4 + rand() * 20;

    /** Tint, and the block killing it yields. Set by the manager for sheep. */
    this.tint = species.tint;
    this.drop = null;

    /** Skylight where it stands, so an animal in a cave is dark. */
    this.skyLight = 1;
    this.blockLight = 0;

    this._probe = new THREE.Vector3();
  }

  get width() {
    return this.species.width;
  }

  get height() {
    return this.species.height;
  }

  /** Centre of the body, which is what a ray should be tested against. */
  centre(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.height * 0.5, this.position.z);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * @param {number} delta
   * @param {import('../world/world.js').World} world
   * @param {THREE.Vector3} playerPosition
   */
  update(delta, world, playerPosition) {
    this.hurtCooldown = Math.max(0, this.hurtCooldown - delta);
    this.hurtFlash = Math.max(0, this.hurtFlash - delta * 3.2);

    if (this.dead) {
      this.deathTimer += delta;
      // Keep falling while it topples, so a body killed mid-air lands.
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * delta, -TERMINAL_SPEED);
      this.moveAndCollide(delta, world);
      if (this.deathTimer >= DEATH_DURATION) this.removed = true;
      return;
    }

    this.sampleFluids(world);
    this.think(delta, world, playerPosition);
    this.steer(delta, world);
    this.moveAndCollide(delta, world);
    this.animate(delta);
  }

  sampleFluids(world) {
    const feet = world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y + 0.1),
      Math.floor(this.position.z),
    );
    this.inWater = feet === WATER;
    if (feet === LAVA) this.damage(4, 'lava');
  }

  /**
   * Decide what to do next.
   *
   * Deliberately coarse: an animal picks a heading, walks for a few seconds,
   * then stands about. What makes it read as alive is not the plan but the
   * two reflexes layered over it — looking at a player who comes close, and
   * running from whatever just hurt it.
   */
  think(delta, world, playerPosition) {
    this.stateTimer -= delta;
    this.voiceTimer -= delta;

    if (this.stateTimer <= 0) {
      if (this.state === MobState.PANIC) {
        this.state = MobState.WALK;
        this.stateTimer = 2 + Math.random() * 3;
      } else if (this.state === MobState.WALK) {
        this.state = MobState.IDLE;
        this.stateTimer = 1.5 + Math.random() * 5;
      } else {
        this.state = MobState.WALK;
        this.stateTimer = 2 + Math.random() * 6;
        this.targetYaw = Math.random() * Math.PI * 2;
      }
    }

    // Look at the player when they are close enough to be interesting. The
    // head turning to follow you is most of what sells an animal as animate.
    const dx = playerPosition.x - this.position.x;
    const dz = playerPosition.z - this.position.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < 100 && this.state !== MobState.PANIC) {
      const dy = (playerPosition.y + 1.4) - (this.position.y + this.species.eyeHeight);
      const wanted = Math.atan2(-dx, -dz);
      this.headYaw = wrapAngle(wanted - this.yaw);
      // A neck only turns so far; past that the animal would have to turn.
      this.headYaw = THREE.MathUtils.clamp(this.headYaw, -1.2, 1.2);
      this.headPitch = THREE.MathUtils.clamp(-Math.atan2(dy, Math.sqrt(distanceSq)), -0.7, 0.7);
    } else {
      this.headYaw += (0 - this.headYaw) * Math.min(1, delta * 3);
      this.headPitch += (0 - this.headPitch) * Math.min(1, delta * 3);
    }

    if (this.voiceTimer <= 0) {
      this.voiceTimer = 8 + Math.random() * 26;
      this.wantsVoice = true;
    }

    // Turn away from anything ahead that is not worth walking into.
    if (this.state !== MobState.IDLE && this.avoidAhead(world)) {
      this.targetYaw = this.yaw + Math.PI * (0.5 + Math.random());
    }
  }

  /**
   * True when the ground two blocks ahead is missing or drowned.
   *
   * Without this an animal walks off every ledge it meets, and a herd empties
   * into the nearest ravine within a minute of spawning.
   */
  avoidAhead(world) {
    const ahead = this._probe.set(
      this.position.x - Math.sin(this.yaw) * 1.4,
      this.position.y,
      this.position.z - Math.cos(this.yaw) * 1.4,
    );
    const bx = Math.floor(ahead.x);
    const bz = Math.floor(ahead.z);
    const feetY = Math.floor(this.position.y);

    // A drop of more than two blocks, or water, is a reason to turn.
    let solidBelow = false;
    for (let dy = 0; dy >= -2; dy--) {
      const id = world.getBlock(bx, feetY + dy - 1, bz);
      if (id === WATER || id === LAVA) return true;
      if (id !== AIR && world.tables.solid[id] === 1) {
        solidBelow = true;
        break;
      }
    }
    if (!solidBelow) return true;

    // A wall more than one block tall is also a reason to turn; one block is
    // just a step, and the animal jumps it.
    return this.isSolid(world, bx, feetY + 1, bz) && this.isSolid(world, bx, feetY + 2, bz);
  }

  /** Turn toward the current heading and push along it. */
  steer(delta, world) {
    const moving = this.state !== MobState.IDLE;

    if (moving) {
      // Turn at a bounded rate rather than snapping, so a change of mind reads
      // as an animal turning rather than a sprite flipping.
      const turn = wrapAngle(this.targetYaw - this.yaw);
      const rate = this.state === MobState.PANIC ? 5 : 2.2;
      this.yaw += THREE.MathUtils.clamp(turn, -rate * delta, rate * delta);
      this.yaw = wrapAngle(this.yaw);
    }

    const speed = this.state === MobState.PANIC ? this.species.panicSpeed : this.species.speed;
    const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const drag = this.onGround ? GROUND_DRAG : AIR_DRAG;

    if (moving) {
      const targetX = -Math.sin(this.yaw) * speed;
      const targetZ = -Math.cos(this.yaw) * speed;
      const blend = 1 - Math.exp(-accel * delta);
      this.velocity.x += (targetX - this.velocity.x) * blend;
      this.velocity.z += (targetZ - this.velocity.z) * blend;
    } else {
      const decay = Math.exp(-drag * delta);
      this.velocity.x *= decay;
      this.velocity.z *= decay;
    }

    if (this.inWater) {
      // Float rather than drown. Animals here cannot swim anywhere useful, so
      // bobbing at the surface is both kinder and less work than pathfinding.
      this.velocity.y += (2.2 - this.velocity.y) * Math.min(1, delta * 6);
      this.fallDistance = 0;
      return;
    }

    // Hop over a one-block step in the way, which is how a fence-free world
    // stays traversable without any path planning.
    if (moving && this.onGround && this.blockedAhead(world)) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }

    const gravity = !this.onGround && this.species.glide && this.velocity.y < 0
      ? GRAVITY * this.species.glide
      : GRAVITY;
    this.velocity.y = Math.max(this.velocity.y - gravity * delta, -TERMINAL_SPEED);
  }

  blockedAhead(world) {
    const bx = Math.floor(this.position.x - Math.sin(this.yaw) * (this.width * 0.5 + 0.25));
    const bz = Math.floor(this.position.z - Math.cos(this.yaw) * (this.width * 0.5 + 0.25));
    const feetY = Math.floor(this.position.y + 0.1);
    if (!this.isSolid(world, bx, feetY, bz)) return false;
    // Only worth jumping if there is somewhere to land.
    return !this.isSolid(world, bx, feetY + 1, bz)
      && !this.isSolid(world, bx, feetY + Math.ceil(this.height), bz);
  }

  /** Walk cycle amplitude follows actual speed, so a stop eases out. */
  animate(delta) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += speed * delta * 3.4;
    const target = Math.min(1, speed / Math.max(0.5, this.species.speed));
    this.walkAmount += (target - this.walkAmount) * Math.min(1, delta * 8);
    // Wings beat hard while falling and idle otherwise.
    const flapping = this.species.glide && !this.onGround;
    this.wingPhase += delta * (flapping ? 22 : 2.4);
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  isSolid(world, x, y, z) {
    const id = world.getBlock(x, y, z);
    if (id === AIR) return false;
    return world.tables.solid[id] === 1;
  }

  collidesAt(world, x, y, z) {
    const half = this.width / 2;
    const minX = Math.floor(x - half + SKIN);
    const maxX = Math.floor(x + half - SKIN);
    const minY = Math.floor(y + SKIN);
    const maxY = Math.floor(y + this.height - SKIN);
    const minZ = Math.floor(z - half + SKIN);
    const maxZ = Math.floor(z + half - SKIN);

    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        for (let bx = minX; bx <= maxX; bx++) {
          if (this.isSolid(world, bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  moveAndCollide(delta, world) {
    const step = this._probe.copy(this.velocity).multiplyScalar(delta);
    const distance = step.length();
    const parts = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
    step.divideScalar(parts);

    this.onGround = false;
    for (let i = 0; i < parts; i++) {
      this.moveAxisY(world, step.y);
      this.moveAxis(world, 'x', step.x);
      this.moveAxis(world, 'z', step.z);
    }

    if (this.onGround) {
      if (this.fallDistance > SAFE_FALL && !this.inWater) {
        this.damage(Math.floor(this.fallDistance - SAFE_FALL) + 1, 'fall');
      }
      this.fallDistance = 0;
    } else if (this.velocity.y < 0) {
      this.fallDistance -= this.velocity.y * delta;
    }
  }

  moveAxisY(world, amount) {
    if (amount === 0) return;
    const next = this.position.y + amount;
    if (!this.collidesAt(world, this.position.x, next, this.position.z)) {
      this.position.y = next;
      return;
    }
    if (amount > 0) {
      this.position.y = Math.floor(next + this.height) - this.height - SKIN;
      if (this.velocity.y > 0) this.velocity.y = 0;
    } else {
      this.position.y = Math.floor(next) + 1 + SKIN;
      this.velocity.y = 0;
      this.onGround = true;
    }
  }

  moveAxis(world, axis, amount) {
    if (amount === 0) return;
    const half = this.width / 2;
    const next = this.position[axis] + amount;
    const x = axis === 'x' ? next : this.position.x;
    const z = axis === 'z' ? next : this.position.z;
    if (!this.collidesAt(world, x, this.position.y, z)) {
      this.position[axis] = next;
      return;
    }
    this.position[axis] = amount > 0
      ? Math.floor(next + half) - half - SKIN
      : Math.floor(next - half) + 1 + half + SKIN;
    this.velocity[axis] = 0;
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /**
   * Take a hit. `knockback` is a world-space direction the blow came from.
   * Returns true if the hit actually landed.
   */
  damage(amount, cause = 'generic', knockback = null) {
    if (this.dead || amount <= 0) return false;
    if (this.hurtCooldown > 0 && cause !== 'lava') return false;

    this.health -= amount;
    this.hurtCooldown = HURT_COOLDOWN;
    this.hurtFlash = 1;

    if (knockback) {
      this.velocity.x += knockback.x * 5.5;
      this.velocity.z += knockback.z * 5.5;
      this.velocity.y = Math.max(this.velocity.y, 4.2);
      // Face away from whatever hit it, then run.
      this.targetYaw = Math.atan2(-knockback.x, -knockback.z);
      this.yaw = this.targetYaw;
    }

    if (this.health <= 0) {
      this.dead = true;
      this.deathTimer = 0;
      return true;
    }

    this.state = MobState.PANIC;
    this.stateTimer = 2.5 + Math.random() * 2;
    return true;
  }

  /** 0 while upright, 1 once fully toppled. Drives the death roll. */
  get deathProgress() {
    if (!this.dead) return 0;
    return Math.min(1, this.deathTimer / DEATH_DURATION);
  }
}

/** Wrap an angle into -PI..PI. */
function wrapAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
