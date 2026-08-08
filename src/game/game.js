/**
 * A running world session.
 *
 * Owns the world, the player and everything that reacts to them, and is the
 * only place the per-frame ordering of those systems is decided. Creating a
 * `Game` loads a save; disposing it releases every GPU resource it allocated,
 * so switching worlds from the menu leaks nothing.
 *
 * Frame order matters and is deliberate:
 *   input actions -> player physics -> interaction -> streaming -> effects ->
 *   camera -> view models -> UI.
 * The camera is placed after physics so it never renders a frame behind the
 * body, and streaming runs after physics so the chunk queue is centred on where
 * the player actually ended up this frame.
 */

import * as THREE from 'three';
import { World } from '../world/world.js';
import { Player, GameMode, Perspective } from '../entity/player.js';
import { PlayerModel } from '../entity/player-model.js';
import { Inventory } from './inventory.js';
import { Interaction } from './interaction.js';
import { Particles } from './particles.js';
import { createCommands } from './commands.js';
import { BlockHighlight } from '../render/highlight.js';
import { ViewModel } from '../render/view-model.js';
import { DAY_LENGTH } from '../render/sky.js';
import { Hud } from '../ui/hud.js';
import { InventoryUI } from '../ui/inventory-ui.js';
import { Chat } from '../ui/chat.js';
import { DebugOverlay } from '../ui/debug.js';
import { el, button } from '../ui/dom.js';
import { toChunkCoord, toLocalCoord, WORLD_HEIGHT } from '../world/constants.js';
import { getBiome } from '../world/worldgen/biomes.js';
import {
  AIR, WATER, LAVA, GRASS_BLOCK, DIRT, STONE, COBBLESTONE, OAK_LOG, OAK_PLANKS,
  SAND, GLASS, TORCH, getBlock,
} from '../world/blocks.js';

/** Hotbar a brand-new creative world starts with. */
const STARTER_HOTBAR = [
  GRASS_BLOCK, DIRT, STONE, COBBLESTONE, OAK_LOG, OAK_PLANKS, SAND, GLASS, TORCH,
];

const AUTOSAVE_SECONDS = 45;

export class Game {
  /**
   * @param {object} context
   * @param {import('../core/engine.js').Engine} context.engine
   * @param {import('../core/input.js').Input} context.input
   * @param {import('../core/settings.js').Settings} context.settings
   * @param {import('../core/audio.js').AudioEngine} context.audio
   * @param {import('../core/storage.js').WorldStore} context.store
   * @param {import('../render/materials.js').WorldMaterials} context.materials
   * @param {import('../render/sky.js').Sky} context.sky
   * @param {object} context.atlas
   * @param {object} context.dom  named UI containers from index.html
   */
  constructor(context) {
    Object.assign(this, context);

    this.paused = false;
    this.playTime = 0;
    this.autosaveTimer = 0;
    this.pendingScreenshot = false;
    this.fovCurrent = this.settings.get('fov');
    this.ambientTimer = 0;
    /** Smoothed 0..1 submersion, so surfacing fades rather than cuts. */
    this.underwater = 0;

    /** Called when the session wants the pause menu shown. */
    this.onPause = null;
    /** Called when the session un-pauses, so the shell can hide the menu. */
    this.onResume = null;
    /** Called when the player asks to leave the world. */
    this.onQuit = null;

    this._tint = [1, 1, 1];
    this._probe = new THREE.Vector3();
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Build the world and stream the spawn area.
   * @param {object} meta  the world record from storage
   * @param {(fraction: number, status: string) => void} onProgress
   */
  async load(meta, onProgress) {
    this.meta = meta;

    onProgress(0.05, 'Reading save');
    const savedEdits = await this.store.loadEdits(meta.id);
    const savedPlayer = await this.store.loadPlayer(meta.id);

    onProgress(0.12, 'Seeding world');
    this.world = new World({
      seed: meta.seed,
      scene: this.engine.scene,
      materials: this.materials,
      worldType: meta.worldType,
      caveDensity: meta.caveDensity,
      treeDensity: meta.treeDensity,
      savedEdits,
    });
    this.world.setRenderDistance(this.settings.get('renderDistance'));
    this.engine.setRenderDistance(this.settings.get('renderDistance'));

    this.player = new Player({ world: this.world, input: this.input, settings: this.settings });
    this.inventory = new Inventory();

    if (savedPlayer?.player) {
      this.player.load(savedPlayer.player);
      this.inventory.load(savedPlayer.inventory);
      if (typeof savedPlayer.timeOfDay === 'number') this.sky.setTime(savedPlayer.timeOfDay);
      this.playTime = savedPlayer.playTime ?? 0;
    } else {
      onProgress(0.2, 'Finding a spawn');
      const spawn = this.world.findSpawn();
      this.player.teleport(spawn.x, spawn.y, spawn.z);
      this.player.spawnPoint.set(spawn.x, spawn.y, spawn.z);
      this.player.setGameMode(meta.gameMode ?? GameMode.SURVIVAL);
      this.sky.setTime(0.3);
      this.spawnBiome = spawn.biome;
    }

    this.player.setGameMode(this.player.gameMode);
    this.inventory.infinite = this.player.gameMode === GameMode.CREATIVE;
    if (!savedPlayer && this.inventory.infinite) this.inventory.fill(STARTER_HOTBAR);

    this.buildSystems();

    onProgress(0.3, 'Generating terrain');
    await this.streamSpawnArea(onProgress);

    // Drop the player onto the ground if the save left them mid-air or the
    // terrain under a stored position changed.
    this.settleOnGround();

    if (this.spawnBiome !== undefined) {
      this.hud.toast(`Welcome to ${getBiome(this.spawnBiome).display}`, { seconds: 4.5 });
    }

    // Shown here rather than during setup so its timer starts when the player
    // can actually read it, not while the loading screen is still up.
    this.hud.showHint(
      'Click to play &nbsp;·&nbsp; <b>WASD</b> move &nbsp;·&nbsp; <b>Space</b> jump &nbsp;·&nbsp; '
      + '<b>LMB</b> mine &nbsp;·&nbsp; <b>RMB</b> place &nbsp;·&nbsp; <b>E</b> inventory &nbsp;·&nbsp; <b>F3</b> debug',
      12,
    );

    onProgress(1, 'Ready');
  }

  buildSystems() {
    const scene = this.engine.scene;

    this.particles = new Particles(scene, { materials: this.materials });
    this.highlight = new BlockHighlight(scene);
    this.viewModel = new ViewModel(this.atlas);
    this.playerModel = new PlayerModel(scene, this.atlas);

    this.interaction = new Interaction({
      world: this.world,
      player: this.player,
      inventory: this.inventory,
      input: this.input,
      particles: this.particles,
      audio: this.audio,
      highlight: this.highlight,
      viewModel: this.viewModel,
      playerModel: this.playerModel,
    });

    this.hud = new Hud({ root: this.dom.hud, inventory: this.inventory });
    this.inventoryUI = new InventoryUI({
      root: this.dom.inventory,
      inventory: this.inventory,
      player: this.player,
      audio: this.audio,
    });
    this.inventoryUI.onClose = () => this.afterOverlayClosed();

    this.commands = createCommands(this);
    this.chat = new Chat({
      root: this.dom.chat,
      audio: this.audio,
      onSubmit: (text) => this.commands.run(text),
    });
    this.chat.onClose = () => this.afterOverlayClosed();

    this.debug = new DebugOverlay(this.hud.debug);

    this.bindPlayerEvents();
    this.buildDeathScreen();

    this.hud.setVisible(true);
    this.unsubscribeSettings = this.settings.subscribe((key, value) => this.applySetting(key, value));
    this.settings.emitAll();
  }

  bindPlayerEvents() {
    this.player.onFootstep = (material, gain, landing) => {
      this.audio.block('step', material, this.player.position);
      if (!landing) return;
      this.audio.effect('land', { position: this.player.position, gain: gain * 0.6 });
      const color = this.interaction.blockColor(
        this.world.getBlock(
          Math.floor(this.player.position.x),
          Math.floor(this.player.position.y - 0.2),
          Math.floor(this.player.position.z),
        ),
        Math.floor(this.player.position.x),
        Math.floor(this.player.position.z),
      );
      this.particles.footstep(this.player.position.x, this.player.position.y, this.player.position.z, color);
    };

    this.player.onEnterFluid = (kind, position) => {
      if (kind === 'water') {
        this.particles.splash(position.x, position.y, position.z);
        this.audio.effect('splash', { position });
      } else {
        this.audio.effect('swim', { position, gain: 0.5 });
      }
    };

    this.player.onDamage = (amount, cause) => {
      this.audio.effect('hurt');
      if (cause === 'void') this.hud.toast('The void is not survivable.', { tone: 'error' });
    };

    this.player.onDeath = (cause) => {
      this.audio.effect('hurt', { gain: 1.4, rate: 0.7 });
      this.deathCause.textContent = DEATH_MESSAGES[cause] ?? 'You died.';
      this.input.releaseLock();
    };
  }

  buildDeathScreen() {
    this.deathCause = el('p.death__cause', { text: 'You died.' });
    this.hud.setDeathContent([
      el('h2.death__title', { text: 'You Died' }),
      this.deathCause,
      el('div.death__actions', {}, [
        button('Respawn', () => this.respawn(), { variant: 'primary' }),
        button('Quit to Title', () => this.requestQuit()),
      ]),
    ]);
  }

  /**
   * Generate and mesh everything in view before handing control over, so the
   * first frame the player sees is a finished world rather than a popping one.
   */
  async streamSpawnArea(onProgress) {
    const total = Math.max(1, this.world.prepare(this.player.position));
    let guard = 0;
    while (!this.world.isViewComplete() && guard < 4000) {
      guard++;
      this.world.update(this.player.position, 14);
      const done = 1 - this.world.pending.length / total;
      onProgress(0.3 + done * 0.65, 'Generating terrain');
      await nextFrame();
    }
  }

  /** Move the player down to the first solid ground under them. */
  settleOnGround() {
    const { x, z } = this.player.position;
    if (!this.player.collidesAt(x, this.player.position.y, z)) {
      for (let y = Math.floor(this.player.position.y); y > 0; y--) {
        if (this.player.isSolid(Math.floor(x), y - 1, Math.floor(z))) {
          this.player.position.y = Math.min(this.player.position.y, y);
          return;
        }
      }
      return;
    }
    // Stuck inside terrain: rise until there is room.
    for (let y = Math.floor(this.player.position.y); y < WORLD_HEIGHT; y++) {
      if (!this.player.collidesAt(x, y, z)) {
        this.player.position.y = y;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  applySetting(key, value) {
    switch (key) {
      case 'renderDistance':
        this.world.setRenderDistance(value);
        this.engine.setRenderDistance(value);
        break;
      case 'sensitivity':
        this.input.sensitivity = value * 0.001;
        break;
      case 'invertY':
        this.input.invertY = value;
        break;
      case 'brightness':
        this.materials.setBrightness(value);
        break;
      case 'resolutionScale':
        this.engine.setRenderScale(value);
        break;
      case 'wind':
        this.materials.setWind(value);
        break;
      case 'clouds':
        this.sky.setCloudCoverage(value ? 0.5 : 1.2);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** True while any overlay owns the keyboard and mouse. */
  get uiBlocking() {
    return this.paused || this.inventoryUI.isOpen || this.chat.isOpen || this.player.dead;
  }

  update(delta) {
    this.input.enabled = !this.uiBlocking;
    this.handleActions();

    if (this.paused) {
      this.renderStatic(delta);
      return;
    }

    this.playTime += delta;

    this.player.update(delta);
    this.interaction.update(delta);

    // Streaming budget shrinks when frames are already long, so chunk loading
    // never turns a busy frame into a visible hitch.
    const budget = delta > 0.024 ? 3 : 7;
    this.world.update(this.player.position, budget);

    this.updateSky(delta);
    this.particles.update(delta, this.world);
    this.updateAmbient(delta);

    this.player.updateCamera(this.engine.camera, delta);
    // The sky dome and the underwater probe both key off the camera, so they
    // run after it moves. A frame's lag here shows up as the sky sliding
    // against the world when the player sprints.
    this.sky.follow(this.engine.camera);
    this.updateUnderwater(delta);
    this.updateFov(delta);

    this.updateViewModels(delta);

    this.audio.setListener(this.player.getEyePosition(), this.engine.camera);

    this.hud.update(delta, {
      player: this.player,
      fps: this.engine.fps,
      showFps: this.settings.get('showFps'),
    });
    this.debug.update(delta, {
      engine: this.engine, world: this.world, sky: this.sky,
      player: this.player, atlas: this.atlas, meta: this.meta,
    });
    this.chat.update();

    this.updateAutosave(delta);
  }

  /** While paused, keep the view alive but stop the world. */
  renderStatic(delta) {
    this.materials.setTime(this.engine.elapsed);
    this.hud.update(delta, {
      player: this.player,
      fps: this.engine.fps,
      showFps: this.settings.get('showFps'),
    });
    this.chat.update();
  }

  updateSky(delta) {
    const dayLength = this.settings.get('dayLength');
    // Scale the clock rather than the frame: a shorter day is the same cycle
    // running faster, so every derived colour stays consistent.
    const skyDelta = dayLength > 0 ? delta * (DAY_LENGTH / dayLength) : 0;
    this.sky.update(skyDelta, this.engine.elapsed);
    this.materials.applySky(this.sky);
    this.materials.setTime(this.engine.elapsed);
  }

  /**
   * Fog and tint switch to the underwater palette when the camera submerges.
   * Blended over a few frames rather than snapped: breaking the surface is a
   * gradual change in what you can see, and a hard cut reads as a glitch.
   */
  updateUnderwater(delta) {
    const camera = this.engine.camera.position;
    const head = this.world.getBlock(
      Math.floor(camera.x), Math.floor(camera.y), Math.floor(camera.z),
    );
    const target = head === WATER ? 1 : 0;
    const blend = 1 - Math.exp(-14 * delta);
    this.underwater += (target - this.underwater) * blend;
    if (Math.abs(target - this.underwater) < 0.005) this.underwater = target;
    this.materials.setUnderwater(this.underwater);
  }

  /** Occasional embers over exposed lava, and the odd cave drip of sound. */
  updateAmbient(delta) {
    this.ambientTimer += delta;
    if (this.ambientTimer < 0.35) return;
    this.ambientTimer = 0;

    const origin = this.player.position;
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = Math.floor(origin.x + (Math.random() - 0.5) * 22);
      const y = Math.floor(origin.y + (Math.random() - 0.5) * 12);
      const z = Math.floor(origin.z + (Math.random() - 0.5) * 22);
      if (this.world.getBlock(x, y, z) !== LAVA) continue;
      if (this.world.getBlock(x, y + 1, z) !== AIR) continue;
      this.particles.ember(x, y, z, 1);
      if (Math.random() < 0.25) {
        this.audio.effect('fizz', { position: this._probe.set(x + 0.5, y + 1, z + 0.5), gain: 0.35 });
      }
      break;
    }
  }

  updateFov(delta) {
    let target = this.settings.get('fov');
    if (this.player.sprinting) target += this.player.flying ? 14 : 7;
    if (this.player.submerged) target -= 4;
    const blend = 1 - Math.exp(-9 * delta);
    this.fovCurrent += (target - this.fovCurrent) * blend;
    this.engine.setFov(this.fovCurrent);
    this.viewModel.resize(this.engine.canvas.clientWidth, this.engine.canvas.clientHeight);
  }

  updateViewModels(delta) {
    const eye = this.player.getEyePosition();
    const blockLight = this.world.getBlockLight(
      Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z),
    ) / 15;
    const brightness = this.settings.get('brightness');

    const heldId = this.inventory.selectedId;
    this.viewModel.setHeld(this.player.gameMode === GameMode.SPECTATOR ? 0 : heldId);
    this.viewModel.enabled = this.player.perspective === Perspective.FIRST && !this.player.dead;

    let tint = null;
    const kind = heldId ? this.world.tables.tint[heldId] : 0;
    if (kind !== 0) {
      tint = this.world.getTint(Math.floor(eye.x), Math.floor(eye.z), kind, this._tint);
    }

    this.viewModel.update(delta, { player: this.player, sky: this.sky, blockLight, brightness, tint });
    this.playerModel.update(delta, this.player, this.sky, {
      blockLight,
      brightness,
      cameraDistance: this.engine.camera.position.distanceTo(eye),
    });
  }

  updateAutosave(delta) {
    if (!this.settings.get('autosave')) return;
    this.autosaveTimer += delta;
    if (this.autosaveTimer < AUTOSAVE_SECONDS) return;
    this.autosaveTimer = 0;
    if (!this.world.hasUnsavedChanges) return;
    this.save()
      .then(() => this.hud.toast('World saved', { seconds: 1.4 }))
      .catch((error) => {
        console.warn('[autosave] failed', error);
        this.hud.toast('Could not save the world', { tone: 'error', seconds: 3 });
      });
  }

  render() {
    this.engine.render();
    this.viewModel.render(this.engine.renderer);
    if (this.pendingScreenshot) this.captureScreenshot();
  }

  // -------------------------------------------------------------------------
  // Input actions
  // -------------------------------------------------------------------------

  handleActions() {
    const input = this.input;

    if (this.chat.isOpen) return;

    if (this.player.dead) {
      if (input.wasPressed('jump')) this.respawn();
      return;
    }

    if (this.inventoryUI.isOpen) {
      if (input.wasPressed('inventory') || input.wasPressed('pause')) this.inventoryUI.close();
      return;
    }

    // While paused the menu owns the keyboard, including Escape — it is the
    // only thing that knows whether Escape means "back" or "resume".
    if (this.paused) return;

    if (input.wasPressed('pause')) {
      this.pause();
      return;
    }

    if (input.wasPressed('inventory')) this.openInventory();
    if (input.wasPressed('chat')) this.openChat('');
    if (input.wasPressed('command')) this.openChat('/');
    if (input.wasPressed('drop')) this.dropSelected();
    if (input.wasPressed('debug')) this.debug.toggle();
    if (input.wasPressed('screenshot')) this.pendingScreenshot = true;
    if (input.wasPressed('fullscreen')) this.toggleFullscreen();

    if (input.wasPressed('perspective')) {
      const mode = this.player.cyclePerspective();
      this.hud.toast(['First person', 'Third person', 'Front view'][mode], { seconds: 1.2 });
    }

    for (let i = 0; i < 9; i++) {
      if (input.pressed.has(`Digit${i + 1}`) && this.inventory.selected !== i) {
        this.inventory.select(i);
        this.audio.ui('select');
      }
    }

    const wheel = input.takeWheel();
    if (wheel !== 0) {
      this.inventory.cycle(wheel);
      this.audio.ui('select');
    }
  }

  openInventory() {
    this.inventoryUI.show();
    this.input.releaseLock();
  }

  openChat(prefill) {
    this.chat.show(prefill);
  }

  /** Called when an overlay closes; puts the mouse back in the world. */
  afterOverlayClosed() {
    if (this.paused || this.player.dead) return;
    this.input.requestLock();
  }

  dropSelected() {
    const dropped = this.inventory.dropSelected(false);
    if (!dropped) return;
    // There are no item entities in this world, so a dropped block is gone —
    // one at a time, and always announced, so it is never a silent loss.
    this.hud.toast(`Dropped ${getBlock(dropped.id).display}`, { seconds: 1.4 });
    this.audio.ui('click');
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  captureScreenshot() {
    this.pendingScreenshot = false;
    // Must run in the same task as the render, before the browser composites
    // and clears the drawing buffer.
    try {
      const url = this.engine.renderer.domElement.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = `voxel-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      link.click();
      this.hud.toast('Screenshot saved', { seconds: 1.8 });
    } catch (error) {
      this.hud.toast(`Screenshot failed: ${error.message}`, { tone: 'error' });
    }
  }

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.input.releaseLock();
    this.onPause?.();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.onResume?.();
    this.input.requestLock();
  }

  respawn() {
    this.player.respawn();
    // The stored spawn may now be inside something the player built.
    if (this.player.collidesAt(this.player.position.x, this.player.position.y, this.player.position.z)) {
      const spawn = this.world.findSpawn();
      this.player.teleport(spawn.x, spawn.y, spawn.z);
    }
    this.settleOnGround();
    this.hud.toast('Respawned', { seconds: 1.6 });
    this.input.requestLock();
  }

  setGameMode(mode) {
    this.player.setGameMode(mode);
    this.inventory.infinite = mode === GameMode.CREATIVE;
    this.inventory.touch();
    this.meta.gameMode = mode;
  }

  currentBiomeName() {
    const x = Math.floor(this.player.position.x);
    const z = Math.floor(this.player.position.z);
    const chunk = this.world.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (!chunk) return 'Unknown';
    return getBiome(chunk.getBiome(toLocalCoord(x), toLocalCoord(z))).display;
  }

  async save() {
    const writes = this.world.takePendingWrites();
    await this.store.saveEdits(this.meta.id, writes);
    await this.store.savePlayer(this.meta.id, {
      player: this.player.serialize(),
      inventory: this.inventory.serialize(),
      timeOfDay: this.sky.timeOfDay,
      playTime: this.playTime,
    });
    this.meta = await this.store.putWorld({ ...this.meta, playTime: this.playTime });
  }

  requestQuit() {
    this.onQuit?.();
  }

  dispose() {
    this.unsubscribeSettings?.();
    this.interaction.enabled = false;
    this.particles.dispose();
    this.highlight.dispose();
    this.viewModel.dispose();
    this.playerModel.dispose();
    this.world.dispose();
    this.hud.setVisible(false);
    this.inventoryUI.dispose();
    this.chat.dispose();
  }
}

const DEATH_MESSAGES = {
  fall: 'You hit the ground too hard.',
  drown: 'You ran out of air.',
  lava: 'You tried to swim in lava.',
  void: 'You fell out of the world.',
  command: 'You asked for it.',
};

/** Yield to the browser, with a timer fallback for backgrounded tabs. */
function nextFrame() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(done);
    setTimeout(done, 40);
  });
}
