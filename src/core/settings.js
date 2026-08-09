/**
 * Player settings.
 *
 * One flat object, persisted to localStorage and read by every system that
 * needs it. Systems subscribe rather than poll, so moving a slider in the
 * settings screen takes effect immediately in the running game instead of on
 * the next reload.
 *
 * Values here are stored in *human* units (sensitivity 1..10, fov in degrees).
 * The conversion to engine units happens at the point of use, so the settings
 * file stays readable if a player ever opens it.
 */

import { DEFAULT_BINDINGS } from './input.js';

const STORAGE_KEY = 'voxel.settings.v2';

export const SETTING_DEFAULTS = {
  /** Chunk radius loaded around the player. */
  renderDistance: 8,
  fov: 75,
  /** 1..10, multiplied by 0.001 to get radians per mouse unit. */
  sensitivity: 2.2,
  invertY: false,
  viewBobbing: true,
  /** Multiplier on the world shader's final lighting. */
  brightness: 1,
  /** Multiplier on the device pixel ratio; below 1 renders and upscales. */
  resolutionScale: 1,
  /**
   * 'fancy' turns on per-pixel surface relief, sun highlights and emissive
   * blocks. 'fast' drops all three for the flat-shaded look, which is a real
   * saving on a phone GPU.
   */
  graphics: 'fancy',
  clouds: true,
  /**
   * The post-processing chain: bloom, sun shafts, tone mapping, vignette.
   * Off renders straight to the screen the way the game did before it existed.
   */
  postFx: true,
  /** Bloom strength. 0 switches the pass off without disabling the chain. */
  bloom: 0.7,
  /** Sun shaft strength. */
  godRays: 0.7,
  vignette: 0.5,
  /** Exposure applied before tone mapping. */
  exposure: 1,
  /** Cast shadows from the sun. */
  shadows: true,
  shadowQuality: 'medium',
  /** How much drifting cloud cover dims the ground, 0..1. */
  cloudShadows: 0.5,
  /** How far the wind pushes plants, in blocks. */
  wind: 0.06,
  volume: 0.65,
  showFps: false,
  autosave: true,
  /** Real seconds per in-game day. 0 freezes time. */
  dayLength: 1200,
  /** Whether animals spawn and wander at all. */
  animals: true,
  /** Multiplier on how many animals a world carries at once. */
  animalDensity: 1,
  /**
   * Mobile mode: touch controls plus a layout sized for a phone.
   * 'auto' follows the device, 'on' and 'off' are the player's override —
   * which matters on tablets and touchscreen laptops, where the device tells
   * you what it supports but not how it is being used.
   */
  touchMode: 'auto',
  /** Radians per pixel dragged, before the 0.001 scale. */
  touchSensitivity: 3,
  /** Left-handed players get the stick and the buttons the other way round. */
  touchSwapSides: false,
  /** Push the stick sideways and the view follows, instead of sidestepping. */
  turnWithMovement: true,
};

/**
 * Validators, so a value that reaches `values` is always usable.
 *
 * Settings are persisted to localStorage, which anything can write to, and a
 * single bad number here reaches the camera: a NaN sensitivity turns the view
 * matrix to NaN on the first mouse move and the world renders black from then
 * on. Clamping on the way in is much easier to reason about than defending at
 * every point of use.
 */
const SETTING_RULES = {
  renderDistance: { type: 'number', min: 2, max: 24, integer: true },
  fov: { type: 'number', min: 30, max: 130 },
  sensitivity: { type: 'number', min: 0.1, max: 20 },
  invertY: { type: 'boolean' },
  viewBobbing: { type: 'boolean' },
  brightness: { type: 'number', min: 0.2, max: 3 },
  resolutionScale: { type: 'number', min: 0.25, max: 2 },
  graphics: { type: 'enum', values: ['fast', 'fancy'] },
  clouds: { type: 'boolean' },
  postFx: { type: 'boolean' },
  bloom: { type: 'number', min: 0, max: 1.5 },
  godRays: { type: 'number', min: 0, max: 1.5 },
  vignette: { type: 'number', min: 0, max: 1.5 },
  exposure: { type: 'number', min: 0.5, max: 1.8 },
  shadows: { type: 'boolean' },
  shadowQuality: { type: 'enum', values: ['low', 'medium', 'high'] },
  cloudShadows: { type: 'number', min: 0, max: 1 },
  wind: { type: 'number', min: 0, max: 1 },
  volume: { type: 'number', min: 0, max: 1 },
  showFps: { type: 'boolean' },
  autosave: { type: 'boolean' },
  dayLength: { type: 'number', min: 0, max: 7200 },
  animals: { type: 'boolean' },
  animalDensity: { type: 'number', min: 0.2, max: 2 },
  touchMode: { type: 'enum', values: ['auto', 'on', 'off'] },
  touchSensitivity: { type: 'number', min: 0.5, max: 12 },
  touchSwapSides: { type: 'boolean' },
  turnWithMovement: { type: 'boolean' },
};

/**
 * Coerce a value into something the rest of the game can use, or return
 * `undefined` when it cannot be rescued and the default should stand.
 */
export function sanitizeSetting(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule) return value;

  if (rule.type === 'boolean') return Boolean(value);
  if (rule.type === 'enum') return rule.values.includes(value) ? value : undefined;

  // `Number(null)` is 0 and `Number('')` is 0, which would silently turn a
  // missing value into the bottom of the range. Only something that was
  // already a number, or text that reads as one, is accepted.
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const clamped = Math.min(rule.max, Math.max(rule.min, number));
  return rule.integer ? Math.round(clamped) : clamped;
}

/** Ranges and labels for the settings screen, so the UI stays data-driven. */
export const SETTING_SCHEMA = [
  {
    group: 'Video',
    items: [
      {
        key: 'graphics',
        label: 'Lighting',
        type: 'choice',
        options: [['fancy', 'Fancy'], ['fast', 'Fast']],
        hint: 'Fancy lights every pixel: bumpy stone, sun glinting off water, glowing lava. Fast is flat shading.',
      },
      { key: 'renderDistance', label: 'Render Distance', type: 'range', min: 3, max: 20, step: 1, format: (v) => `${v} chunks` },
      { key: 'fov', label: 'Field of View', type: 'range', min: 60, max: 110, step: 1, format: (v) => `${v}°` },
      { key: 'resolutionScale', label: 'Resolution', type: 'range', min: 0.5, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'brightness', label: 'Brightness', type: 'range', min: 0.6, max: 1.8, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'clouds', label: 'Clouds', type: 'toggle' },
      { key: 'viewBobbing', label: 'View Bobbing', type: 'toggle' },
      { key: 'showFps', label: 'Show FPS', type: 'toggle' },
    ],
  },
  {
    group: 'Shaders',
    items: [
      {
        key: 'shadows',
        label: 'Sun Shadows',
        type: 'toggle',
        hint: 'Trees, buildings and animals cast real shadows that swing round with the sun.',
      },
      {
        key: 'shadowQuality',
        label: 'Shadow Detail',
        type: 'choice',
        options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
      },
      { key: 'cloudShadows', label: 'Cloud Shadows', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`) },
      {
        key: 'postFx',
        label: 'Screen Effects',
        type: 'toggle',
        hint: 'Bloom, sun shafts and filmic tone mapping. The single biggest change to how the world looks.',
      },
      { key: 'bloom', label: 'Bloom', type: 'range', min: 0, max: 1.5, step: 0.05, format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`) },
      { key: 'godRays', label: 'Sun Shafts', type: 'range', min: 0, max: 1.5, step: 0.05, format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`) },
      { key: 'exposure', label: 'Exposure', type: 'range', min: 0.5, max: 1.8, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
      { key: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 1.5, step: 0.05, format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`) },
    ],
  },
  {
    group: 'Controls',
    items: [
      { key: 'sensitivity', label: 'Mouse Sensitivity', type: 'range', min: 0.4, max: 10, step: 0.1, format: (v) => v.toFixed(1) },
      { key: 'invertY', label: 'Invert Y Axis', type: 'toggle' },
    ],
  },
  {
    group: 'Mobile',
    items: [
      {
        key: 'touchMode',
        label: 'Mobile Mode',
        type: 'choice',
        options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']],
        hint: 'Touch controls and a phone-sized interface. Auto turns them on for touchscreens.',
      },
      { key: 'touchSensitivity', label: 'Touch Look Speed', type: 'range', min: 0.5, max: 8, step: 0.1, format: (v) => v.toFixed(1) },
      {
        key: 'turnWithMovement',
        label: 'Turn With Movement',
        type: 'toggle',
        hint: 'Steer with the stick: push it sideways and you turn to face that way instead of sidestepping.',
      },
      { key: 'touchSwapSides', label: 'Left-handed Layout', type: 'toggle' },
    ],
  },
  {
    group: 'World',
    items: [
      { key: 'dayLength', label: 'Day Length', type: 'range', min: 0, max: 3600, step: 60, format: (v) => (v === 0 ? 'Frozen' : `${Math.round(v / 60)} min`) },
      { key: 'wind', label: 'Wind', type: 'range', min: 0, max: 0.2, step: 0.01, format: (v) => (v === 0 ? 'Still' : `${Math.round(v * 500)}%`) },
      {
        key: 'animals',
        label: 'Animals',
        type: 'toggle',
        hint: 'Pigs, cows, sheep and chickens wander the surface and can be hit.',
      },
      { key: 'animalDensity', label: 'Animal Density', type: 'range', min: 0.2, max: 2, step: 0.1, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'autosave', label: 'Autosave', type: 'toggle' },
    ],
  },
  {
    group: 'Audio',
    items: [
      { key: 'volume', label: 'Master Volume', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`) },
    ],
  },
];

export class Settings {
  constructor() {
    this.values = { ...SETTING_DEFAULTS };
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.listeners = new Set();
    /** False on a first run, so first-launch defaults can be tuned per device. */
    this.restored = false;
    this.load();
  }

  get(key) {
    return this.values[key];
  }

  /** Write a value and notify subscribers. No-ops if nothing changed. */
  set(key, value) {
    const next = sanitizeSetting(key, value);
    if (next === undefined) return;
    if (this.values[key] === next) return;
    this.values[key] = next;
    this.save();
    this.emit(key, next);
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(key, value) {
    for (const listener of this.listeners) listener(key, value, this);
  }

  /** Re-emit everything, so a newly created system can pull current state. */
  emitAll() {
    for (const key of Object.keys(this.values)) this.emit(key, this.values[key]);
  }

  rebind(action, code) {
    this.bindings[action] = [code];
    this.save();
    this.emit('bindings', this.bindings);
  }

  resetBindings() {
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.save();
    this.emit('bindings', this.bindings);
  }

  reset() {
    this.values = { ...SETTING_DEFAULTS };
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.save();
    this.emitAll();
    this.emit('bindings', this.bindings);
  }

  load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private browsing or a blocked origin: run on defaults rather than fail.
      return;
    }
    if (!raw) return;
    this.restored = true;
    try {
      const parsed = JSON.parse(raw);
      // Merge key by key so a settings file written by an older build still
      // loads, picking up defaults for anything it does not know about. Each
      // value is validated on the way in — a stored NaN or a string where a
      // number belongs would otherwise reach the renderer.
      for (const key of Object.keys(SETTING_DEFAULTS)) {
        if (!parsed.values || !(key in parsed.values)) continue;
        const value = sanitizeSetting(key, parsed.values[key]);
        if (value !== undefined) this.values[key] = value;
      }
      if (parsed.bindings) {
        for (const action of Object.keys(DEFAULT_BINDINGS)) {
          if (Array.isArray(parsed.bindings[action])) {
            this.bindings[action] = parsed.bindings[action];
          }
        }
      }
    } catch (error) {
      console.warn('[settings] ignoring corrupt saved settings', error);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        values: this.values,
        bindings: this.bindings,
      }));
    } catch {
      // Nothing useful to do; the game runs fine unpersisted.
    }
  }
}
