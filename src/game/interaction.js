/**
 * Block breaking and placing.
 *
 * Owns the crosshair target, mining progress, and every rule about whether an
 * edit is legal. Keeping all of it here means `World.setBlock` stays a dumb,
 * always-succeeds write and the rules live in one readable place.
 *
 * Mining is time-based rather than click-based: progress accumulates against
 * the block's hardness while the button is held, and resets the moment the
 * crosshair leaves the block. That reset is what makes mining feel physical —
 * you cannot chip away at four blocks at once by sweeping across them.
 */

import * as THREE from 'three';
import { raycast } from './raycast.js';
import { PLAYER_SIZE, GameMode } from '../entity/player.js';
import { AIR, BLOCKS, Render, getBlock } from '../world/blocks.js';
import { blockAverageColor } from '../render/atlas.js';

const SURVIVAL_REACH = 4.5;
const CREATIVE_REACH = 6;

/** Creative breaking is instant, but not faster than this, or a held click
 *  would tunnel a corridor in a single frame. */
const CREATIVE_BREAK_INTERVAL = 0.16;
/** Delay between placements while the button is held down. */
const PLACE_INTERVAL = 0.22;
/** How often mining throws off particles and plays a dig sound. */
const DIG_FEEDBACK_INTERVAL = 0.2;

export class Interaction {
  constructor({ world, player, inventory, input, particles, audio, highlight, viewModel, playerModel }) {
    this.world = world;
    this.player = player;
    this.inventory = inventory;
    this.input = input;
    this.particles = particles;
    this.audio = audio;
    this.highlight = highlight;
    this.viewModel = viewModel;
    this.playerModel = playerModel;

    /** Snapshot of the current crosshair target, or null. */
    this.target = null;
    this.progress = 0;
    this.miningKey = '';
    this.placeCooldown = 0;
    this.breakCooldown = 0;
    this.digTimer = 0;

    this.enabled = true;
    /** Called with (blockId, x, y, z) after a successful break. */
    this.onBreak = null;
    this.onPlace = null;

    this._direction = new THREE.Vector3();
    this._soundPosition = new THREE.Vector3();
    this._color = [1, 1, 1];
  }

  get reach() {
    return this.player.gameMode === GameMode.CREATIVE ? CREATIVE_REACH : SURVIVAL_REACH;
  }

  update(delta) {
    this.placeCooldown = Math.max(0, this.placeCooldown - delta);
    this.breakCooldown = Math.max(0, this.breakCooldown - delta);

    if (!this.enabled || this.player.dead || this.player.gameMode === GameMode.SPECTATOR) {
      this.target = null;
      this.progress = 0;
      this.highlight.hide();
      return;
    }

    this.updateTarget();

    if (this.input.isMouseDown(0)) this.updateMining(delta);
    else this.cancelMining();

    if (this.input.isMouseDown(2)) this.tryPlace();

    if (this.input.wasClicked(1)) this.pickBlock();
  }

  /** Re-cast the crosshair ray and move the selection outline. */
  updateTarget() {
    const eye = this.player.getEyePosition();
    const direction = this.player.getLookDirection(this._direction);
    const hit = raycast(this.world, eye, direction, this.reach);

    if (!hit.hit) {
      this.target = null;
      this.highlight.hide();
      return;
    }

    this.target = {
      id: hit.id,
      x: hit.x, y: hit.y, z: hit.z,
      px: hit.px, py: hit.py, pz: hit.pz,
      nx: hit.nx, ny: hit.ny, nz: hit.nz,
    };
    this.highlight.setTarget(hit.x, hit.y, hit.z);
  }

  // -------------------------------------------------------------------------
  // Breaking
  // -------------------------------------------------------------------------

  /** Seconds to break a block, or Infinity if it cannot be broken. */
  breakDuration(id) {
    const block = getBlock(id);
    if (this.player.gameMode === GameMode.CREATIVE) {
      return block.hardness < 0 && id !== 0 ? CREATIVE_BREAK_INTERVAL * 2 : CREATIVE_BREAK_INTERVAL;
    }
    if (block.hardness < 0) return Infinity;
    // Bare hands: a flat multiplier on hardness. Tools would scale this.
    return Math.max(0.05, block.hardness * 1.6);
  }

  updateMining(delta) {
    if (!this.target) {
      this.cancelMining();
      return;
    }

    const key = `${this.target.x},${this.target.y},${this.target.z}`;
    if (key !== this.miningKey) {
      this.miningKey = key;
      this.progress = 0;
      this.digTimer = DIG_FEEDBACK_INTERVAL;
    }

    const duration = this.breakDuration(this.target.id);
    if (!Number.isFinite(duration)) {
      this.highlight.setProgress(0);
      this.swing();
      return;
    }

    this.progress += delta / duration;
    this.highlight.setProgress(this.progress);

    this.digTimer += delta;
    if (this.digTimer >= DIG_FEEDBACK_INTERVAL) {
      this.digTimer = 0;
      this.swing();
      this.emitHitFeedback();
    }

    if (this.progress >= 1) this.breakBlock();
  }

  cancelMining() {
    if (this.progress === 0 && this.miningKey === '') return;
    this.progress = 0;
    this.miningKey = '';
    this.highlight.setProgress(0);
  }

  emitHitFeedback() {
    const target = this.target;
    const block = getBlock(target.id);
    this.blockColor(target.id, target.x, target.z);
    this.particles.blockHit(
      target.x, target.y, target.z,
      target.nx, target.ny, target.nz,
      this._color,
    );
    this.audio.block('dig', block.sound, this._soundPosition.set(target.x + 0.5, target.y + 0.5, target.z + 0.5));
  }

  breakBlock() {
    const target = this.target;
    const id = target.id;
    const block = getBlock(id);

    if (!this.world.setBlock(target.x, target.y, target.z, AIR)) return;

    this.blockColor(id, target.x, target.z);
    this.particles.blockBreak(target.x, target.y, target.z, this._color);
    this.audio.block('break', block.sound, this._soundPosition.set(target.x + 0.5, target.y + 0.5, target.z + 0.5));

    if (this.player.gameMode === GameMode.SURVIVAL && block.drops !== null) {
      const leftover = this.inventory.add(block.drops, 1);
      if (leftover === 0) this.audio.effect('pickup', { gain: 0.5 });
    }

    // A plant standing on the broken block has nothing left to stand on.
    this.removeUnsupported(target.x, target.y + 1, target.z);

    this.progress = 0;
    this.miningKey = '';
    this.highlight.setProgress(0);
    this.breakCooldown = 0.05;
    this.onBreak?.(id, target.x, target.y, target.z);
    this.updateTarget();
  }

  /** Drop a cross-shaped block that just lost the ground beneath it. */
  removeUnsupported(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return;
    const block = getBlock(id);
    if (block.render !== Render.CROSS) return;

    this.world.setBlock(x, y, z, AIR);
    this.blockColor(id, x, z);
    this.particles.blockBreak(x, y, z, this._color, 12);
    if (this.player.gameMode === GameMode.SURVIVAL && block.drops !== null) {
      this.inventory.add(block.drops, 1);
    }
    // Sugar cane stacks, so keep walking up the column.
    this.removeUnsupported(x, y + 1, z);
  }

  // -------------------------------------------------------------------------
  // Placing
  // -------------------------------------------------------------------------

  tryPlace() {
    if (this.placeCooldown > 0 || !this.target) return;

    const id = this.inventory.selectedId;
    if (id === AIR) return;

    const position = this.placementPosition();
    if (!position) return;
    if (!this.canPlace(id, position.x, position.y, position.z)) return;

    if (this.inventory.consumeSelected() === 0) return;
    if (!this.world.setBlock(position.x, position.y, position.z, id)) return;

    const block = getBlock(id);
    this.audio.block('place', block.sound, this._soundPosition.set(position.x + 0.5, position.y + 0.5, position.z + 0.5));
    this.swing();
    this.placeCooldown = PLACE_INTERVAL;
    this.onPlace?.(id, position.x, position.y, position.z);
  }

  /**
   * Where a placed block would go: inside the targeted block when that block is
   * replaceable (tall grass, water), otherwise against the face that was hit.
   */
  placementPosition() {
    const target = this.target;
    const hitBlock = getBlock(target.id);
    if (hitBlock.replaceable) return { x: target.x, y: target.y, z: target.z };
    if (target.nx === 0 && target.ny === 0 && target.nz === 0) return null;
    return { x: target.px, y: target.py, z: target.pz };
  }

  canPlace(id, x, y, z) {
    const existing = this.world.getBlock(x, y, z);
    if (existing !== AIR && !getBlock(existing).replaceable) return false;

    const block = BLOCKS[id];
    if (!block) return false;

    // A solid block cannot be placed where the player is standing.
    if (block.solid && this.intersectsPlayer(x, y, z)) return false;

    // Plants and torches need something underneath them.
    if (block.render === Render.CROSS) {
      const below = this.world.getBlock(x, y - 1, z);
      if (below === AIR) return false;
      if (!this.world.tables.solid[below]) return false;
    }

    return true;
  }

  intersectsPlayer(x, y, z) {
    const player = this.player.position;
    const half = PLAYER_SIZE.width / 2;
    return x < player.x + half && x + 1 > player.x - half
      && y < player.y + PLAYER_SIZE.height && y + 1 > player.y
      && z < player.z + half && z + 1 > player.z - half;
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  pickBlock() {
    if (!this.target) return;
    this.inventory.pick(this.target.id);
    this.audio.ui('select');
  }

  swing() {
    this.viewModel?.swing();
    this.playerModel?.swing();
  }

  /**
   * Colour for a block's particles. Tinted blocks (grass, foliage) are painted
   * greyscale and coloured by the biome, so the biome tint has to be applied
   * here too or a broken grass block would spray grey dust.
   */
  blockColor(id, x, z) {
    blockAverageColor(id, this._color);
    const kind = this.world.tables.tint[id];
    if (kind === 0) return this._color;
    const tint = this.world.getTint(x, z, kind);
    if (tint) {
      this._color[0] *= tint[0];
      this._color[1] *= tint[1];
      this._color[2] *= tint[2];
    }
    return this._color;
  }
}
