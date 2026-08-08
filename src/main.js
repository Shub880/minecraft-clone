/**
 * Application shell.
 *
 * Owns the pieces that outlive any single world — renderer, input, settings,
 * audio, storage, the texture atlas, the sky — and switches between the two
 * things the game can be doing: showing the title screen over a slowly
 * drifting panorama, or running a world.
 *
 * There is exactly one frame loop. Both states are driven from it, so there is
 * no chance of two loops racing after a world is loaded or unloaded.
 */

import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { Settings } from './core/settings.js';
import { AudioEngine } from './core/audio.js';
import { WorldStore } from './core/storage.js';
import { buildBlockTextures } from './render/atlas.js';
import { WorldMaterials } from './render/materials.js';
import { Sky } from './render/sky.js';
import { World } from './world/world.js';
import { Menu } from './ui/menu.js';
import { Game } from './game/game.js';
import { WorldType } from './world/worldgen/terrain.js';
import { hashString } from './core/rng.js';

/**
 * Chunk radius behind the title screen. Kept small because it is only ever
 * background, but not so small that the fog needed to hide its edge turns the
 * whole view white.
 */
const PANORAMA_RADIUS = 6;
/** How far the title camera orbits from the spawn point. */
const PANORAMA_ORBIT = 20;

const dom = {
  canvas: document.getElementById('game'),
  boot: document.getElementById('boot'),
  bootFill: document.getElementById('boot-fill'),
  bootStatus: document.getElementById('boot-status'),
  bootTitle: document.getElementById('boot-title'),
  menu: document.getElementById('menu'),
  hud: document.getElementById('hud'),
  inventory: document.getElementById('inventory'),
  chat: document.getElementById('chat'),
};

class App {
  constructor() {
    this.state = 'boot';
    this.game = null;
    this.panorama = null;
    this.lastSaveAt = 0;
  }

  async boot() {
    this.setProgress(0.05, 'Starting renderer');
    await nextFrame();

    this.settings = new Settings();
    this.engine = new Engine(dom.canvas);
    this.input = new Input(dom.canvas);
    this.audio = new AudioEngine(this.settings);

    this.applyInputSettings();
    this.settings.subscribe((key) => {
      if (key === 'sensitivity' || key === 'invertY' || key === 'bindings') this.applyInputSettings();
      if (key === 'resolutionScale') this.engine.setRenderScale(this.settings.get('resolutionScale'));
    });

    this.setProgress(0.16, 'Painting textures');
    await nextFrame();
    this.atlas = buildBlockTextures();

    this.setProgress(0.34, 'Compiling shaders');
    await nextFrame();
    this.materials = new WorldMaterials(this.atlas.texture);
    this.materials.setBrightness(this.settings.get('brightness'));
    this.materials.setWind(this.settings.get('wind'));
    this.sky = new Sky(this.engine.scene);
    this.sky.setCloudCoverage(this.settings.get('clouds') ? 0.5 : 1.2);
    this.engine.setRenderScale(this.settings.get('resolutionScale'));

    this.setProgress(0.46, 'Opening saves');
    this.store = await WorldStore.open();

    this.menu = new Menu({
      root: dom.menu,
      settings: this.settings,
      store: this.store,
      audio: this.audio,
    });
    this.menu.onPlay = (meta) => this.startWorld(meta);
    this.menu.onResume = () => this.game?.resume();
    this.menu.onQuit = () => this.quitToTitle();

    this.setProgress(0.56, 'Building the view');
    await this.buildPanorama();

    this.bindGlobalEvents();

    this.setProgress(1, 'Ready');
    await nextFrame();
    this.hideBoot();

    this.state = 'title';
    this.menu.openTitle();
    requestAnimationFrame(() => this.frame());
  }

  applyInputSettings() {
    this.input.sensitivity = this.settings.get('sensitivity') * 0.001;
    this.input.invertY = this.settings.get('invertY');
    this.input.bindings = structuredClone(this.settings.bindings);
  }

  bindGlobalEvents() {
    // Audio contexts only start inside a gesture, so the first click anywhere
    // is what brings sound to life. The listeners detach themselves once the
    // context is actually running rather than retrying on every keystroke.
    const wake = () => {
      this.audio.resume();
      if (this.audio.context?.state !== 'running') return;
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);

    dom.canvas.addEventListener('click', () => {
      if (this.state !== 'playing' || !this.game) return;
      if (this.game.uiBlocking) return;
      if (!this.input.locked) this.input.requestLock();
    });

    // Losing the pointer means the player pressed Escape or alt-tabbed away.
    this.input.onPointerUnlock = () => {
      if (this.state !== 'playing' || !this.game) return;
      if (this.game.uiBlocking) return;
      this.game.pause();
    };

    window.addEventListener('resize', () => {
      this.game?.viewModel.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
      this.game?.particles.setViewportHeight(dom.canvas.clientHeight);
    });

    // A hidden tab is the most common way a session ends, so save there rather
    // than relying on `beforeunload`, which cannot await a database write.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      if (this.state === 'playing' && this.game?.world.hasUnsavedChanges) {
        this.game.save().catch((error) => console.warn('[save] failed', error));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Title panorama
  // -------------------------------------------------------------------------

  /**
   * A small slice of a real world, drifting behind the menu. It uses the same
   * generator as the game, so the title screen is an honest preview rather
   * than a painting.
   */
  async buildPanorama() {
    const seed = hashString(`panorama-${Math.floor(Math.random() * 1000)}`);
    const world = new World({
      seed,
      scene: this.engine.scene,
      materials: this.materials,
      worldType: WorldType.CONTINENTS,
      treeDensity: 1.4,
    });
    world.setRenderDistance(PANORAMA_RADIUS);
    this.engine.setRenderDistance(PANORAMA_RADIUS + 3);

    const spawn = world.findSpawn();
    const center = new THREE.Vector3(spawn.x, spawn.y + 12, spawn.z);
    this.engine.camera.position.copy(center);

    const total = Math.max(1, world.prepare(this.engine.camera.position));
    let guard = 0;
    while (!world.isViewComplete() && guard < 900) {
      guard++;
      world.update(this.engine.camera.position, 12);
      const done = 1 - world.pending.length / total;
      this.setProgress(0.56 + done * 0.4, 'Growing a world');
      await nextFrame();
    }

    this.panorama = { world, center, angle: Math.random() * Math.PI * 2 };
    this.sky.setTime(0.28);
  }

  updatePanorama(delta) {
    const panorama = this.panorama;
    if (!panorama) return;

    // A slow arc around the spawn point, looking gently downward.
    panorama.angle += delta * 0.028;
    const camera = this.engine.camera;
    camera.position.set(
      panorama.center.x + Math.cos(panorama.angle) * PANORAMA_ORBIT,
      panorama.center.y + Math.sin(panorama.angle * 0.6) * 3,
      panorama.center.z + Math.sin(panorama.angle) * PANORAMA_ORBIT,
    );
    camera.lookAt(panorama.center.x, panorama.center.y - 8, panorama.center.z);

    this.sky.update(delta * 0.6, this.engine.elapsed);
    this.sky.follow(camera);
    this.materials.applySky(this.sky);
    this.materials.setTime(this.engine.elapsed);
    this.materials.setUnderwater(0);
    this.panorama.world.update(camera.position, 4);
  }

  disposePanorama() {
    if (!this.panorama) return;
    this.panorama.world.dispose();
    this.panorama = null;
  }

  // -------------------------------------------------------------------------
  // World lifecycle
  // -------------------------------------------------------------------------

  async startWorld(meta) {
    this.state = 'loading';
    this.menu.close();
    this.showBoot(meta.name);
    this.audio.resume();

    this.disposePanorama();
    // Give the browser a frame to paint the loading screen before the main
    // thread disappears into terrain generation.
    await nextFrame();

    const record = await this.store.putWorld(meta);

    const game = new Game({
      engine: this.engine,
      input: this.input,
      settings: this.settings,
      audio: this.audio,
      store: this.store,
      materials: this.materials,
      sky: this.sky,
      atlas: this.atlas,
      dom,
    });

    try {
      await game.load(record, (fraction, status) => this.setProgress(fraction, status));
    } catch (error) {
      console.error(error);
      this.setProgress(1, `Could not load the world: ${error.message}`);
      dom.bootStatus.classList.add('is-error');
      // The session may be half-built, so disposal is best-effort — but it has
      // to be attempted or a failed load leaks a whole world's geometry.
      try {
        game.dispose();
      } catch (disposeError) {
        console.warn('[load] partial session could not be disposed', disposeError);
      }
      setTimeout(() => this.recoverToTitle(), 3500);
      return;
    }

    game.onPause = () => this.menu.openPause();
    game.onResume = () => this.menu.close();
    game.onQuit = () => this.quitToTitle();
    game.particles.setViewportHeight(dom.canvas.clientHeight);
    game.viewModel.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);

    this.game = game;
    this.state = 'playing';
    this.hideBoot();
    this.input.requestLock();
  }

  /** Get back to a usable title screen after a world failed to load. */
  async recoverToTitle() {
    this.game = null;
    this.setProgress(0.5, 'Returning to the title');
    dom.bootStatus.classList.remove('is-error');
    await this.buildPanorama();
    this.state = 'title';
    this.hideBoot();
    this.menu.openTitle();
  }

  async quitToTitle() {
    if (!this.game) return;
    this.showBoot('Saving');
    this.setProgress(0.5, 'Saving your world');

    try {
      await this.game.save();
    } catch (error) {
      console.warn('[save] failed', error);
    }

    this.game.dispose();
    this.game = null;
    this.input.releaseLock();

    this.setProgress(0.75, 'Returning to the title');
    await this.buildPanorama();

    this.state = 'title';
    this.hideBoot();
    this.menu.openTitle();
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  frame() {
    const delta = this.engine.tick();

    if (this.state === 'playing' && this.game) {
      this.game.update(delta);
      this.game.render();
    } else if (this.state === 'title') {
      this.updatePanorama(delta);
      this.engine.render();
    }

    this.input.endFrame();
    requestAnimationFrame(() => this.frame());
  }

  // -------------------------------------------------------------------------
  // Loading screen
  // -------------------------------------------------------------------------

  showBoot(title) {
    dom.bootTitle.textContent = title ?? 'VOXEL';
    dom.bootStatus.classList.remove('is-error');
    dom.boot.classList.remove('hidden', 'is-leaving');
    this.setProgress(0.02, 'Loading');
  }

  hideBoot() {
    dom.boot.classList.add('is-leaving');
    setTimeout(() => dom.boot.classList.add('hidden'), 550);
  }

  setProgress(fraction, status) {
    dom.bootFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    if (status) dom.bootStatus.textContent = status;
  }
}

/**
 * Yield to the browser so the loading screen can paint between work slices.
 * Races a timer against the animation frame, because a backgrounded tab stops
 * firing rAF entirely and the loader would otherwise hang until the player
 * came back to it.
 */
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

const app = new App();
window.voxel = app;

app.boot().catch((error) => {
  console.error(error);
  dom.bootStatus.textContent = `Failed to start: ${error.message}`;
  dom.bootStatus.classList.add('is-error');
});
