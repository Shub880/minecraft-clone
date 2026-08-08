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
  clouds: true,
  /** How far the wind pushes plants, in blocks. */
  wind: 0.06,
  volume: 0.65,
  showFps: false,
  autosave: true,
  /** Real seconds per in-game day. 0 freezes time. */
  dayLength: 1200,
};

/** Ranges and labels for the settings screen, so the UI stays data-driven. */
export const SETTING_SCHEMA = [
  {
    group: 'Video',
    items: [
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
    group: 'Controls',
    items: [
      { key: 'sensitivity', label: 'Mouse Sensitivity', type: 'range', min: 0.4, max: 10, step: 0.1, format: (v) => v.toFixed(1) },
      { key: 'invertY', label: 'Invert Y Axis', type: 'toggle' },
    ],
  },
  {
    group: 'World',
    items: [
      { key: 'dayLength', label: 'Day Length', type: 'range', min: 0, max: 3600, step: 60, format: (v) => (v === 0 ? 'Frozen' : `${Math.round(v / 60)} min`) },
      { key: 'wind', label: 'Wind', type: 'range', min: 0, max: 0.2, step: 0.01, format: (v) => (v === 0 ? 'Still' : `${Math.round(v * 500)}%`) },
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
    this.load();
  }

  get(key) {
    return this.values[key];
  }

  /** Write a value and notify subscribers. No-ops if nothing changed. */
  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.save();
    this.emit(key, value);
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
    try {
      const parsed = JSON.parse(raw);
      // Merge key by key so a settings file written by an older build still
      // loads, picking up defaults for anything it does not know about.
      for (const key of Object.keys(SETTING_DEFAULTS)) {
        if (parsed.values && key in parsed.values) this.values[key] = parsed.values[key];
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
