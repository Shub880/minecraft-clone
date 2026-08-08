/**
 * Procedural audio.
 *
 * Every sound in the game is synthesised from one shared noise buffer plus a
 * filter and an envelope. No audio files, which keeps the game a single
 * self-contained download and means a block's sound falls out of the material
 * name already declared in the block registry.
 *
 * The design is deliberately narrow: a material defines a *voice* (filter shape
 * and decay), and an action (dig, break, place, step) scales that voice's gain,
 * pitch and length. Nine materials times four actions is thirty-six distinct
 * sounds from twelve lines of data.
 *
 * The context is created lazily, on the first user gesture, because browsers
 * refuse to start audio before one.
 */

import * as THREE from 'three';

/**
 * Filter shape per material group. `freq` is the band centre, `q` its
 * sharpness, `decay` the tail length in seconds, and `tone` an optional
 * sine partial mixed in for materials with a pitched component.
 */
const MATERIALS = {
  stone: { freq: 820, q: 1.1, decay: 0.13, tone: 0, gain: 1 },
  wood: { freq: 500, q: 2.2, decay: 0.14, tone: 190, gain: 1 },
  grass: { freq: 2000, q: 0.7, decay: 0.1, tone: 0, gain: 0.85 },
  gravel: { freq: 1150, q: 0.8, decay: 0.14, tone: 0, gain: 0.95 },
  sand: { freq: 2600, q: 0.55, decay: 0.11, tone: 0, gain: 0.8 },
  snow: { freq: 3100, q: 0.5, decay: 0.09, tone: 0, gain: 0.7 },
  glass: { freq: 3300, q: 3.4, decay: 0.16, tone: 1900, gain: 0.9 },
  water: { freq: 780, q: 0.9, decay: 0.24, tone: 0, gain: 0.9 },
  lava: { freq: 200, q: 1.6, decay: 0.55, tone: 70, gain: 1 },
};

/** How each action reshapes the material voice. */
const ACTIONS = {
  dig: { gain: 0.16, rate: 1.2, length: 0.55, jitter: 0.22 },
  break: { gain: 0.46, rate: 0.82, length: 1.35, jitter: 0.12 },
  place: { gain: 0.4, rate: 1.0, length: 0.9, jitter: 0.1 },
  step: { gain: 0.2, rate: 1.05, length: 0.62, jitter: 0.18 },
};

/** Fully specified one-off sounds that are not tied to a block material. */
const EFFECTS = {
  click: { freq: 2400, q: 4, decay: 0.05, gain: 0.16, tone: 900, toneGain: 0.5 },
  select: { freq: 1800, q: 3, decay: 0.07, gain: 0.14, tone: 1320, toneGain: 0.6 },
  splash: { freq: 1400, q: 0.7, decay: 0.42, gain: 0.42, sweep: -0.7 },
  swim: { freq: 620, q: 1.1, decay: 0.3, gain: 0.16, sweep: 0.4 },
  hurt: { freq: 340, q: 1.4, decay: 0.28, gain: 0.4, tone: 150, toneGain: 0.9, sweep: -0.5 },
  pickup: { freq: 2600, q: 5, decay: 0.09, gain: 0.2, tone: 1760, toneGain: 0.8, sweep: 0.6 },
  land: { freq: 260, q: 1.2, decay: 0.16, gain: 0.3 },
  fizz: { freq: 3000, q: 0.6, decay: 0.6, gain: 0.3, sweep: -0.8 },
};

/** Distance in blocks past which a positional sound is inaudible. */
const MAX_AUDIBLE_DISTANCE = 34;

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.context = null;
    this.master = null;
    this.noise = null;
    this.enabled = true;

    this.listenerPosition = new THREE.Vector3();
    this.listenerRight = new THREE.Vector3(1, 0, 0);

    this._scratch = new THREE.Vector3();

    settings?.subscribe((key, value) => {
      if (key === 'volume' && this.master) {
        this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
      }
    });
  }

  /**
   * Start the audio context. Safe to call repeatedly; browsers only allow the
   * first call that happens inside a user gesture to succeed.
   */
  resume() {
    if (!this.context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) {
        this.enabled = false;
        return;
      }
      this.context = new Context();
      this.master = this.context.createGain();
      this.master.gain.value = this.settings?.get('volume') ?? 0.65;
      this.master.connect(this.context.destination);
      this.noise = this.createNoiseBuffer(2);
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
  }

  /** Two seconds of white noise, the raw material for every sound. */
  createNoiseBuffer(seconds) {
    const rate = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, Math.floor(rate * seconds), rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Where the player's ears are, used to place positional sounds. */
  setListener(position, camera) {
    this.listenerPosition.copy(position);
    // The camera's local X axis is the listener's right, which is all a stereo
    // pan needs. Full HRTF panning would be inaudible on the small, short
    // sounds this game plays.
    this.listenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize();
  }

  /**
   * Build the gain and pan for a world-space sound.
   * Returns null when the source is out of earshot, so the caller can skip it.
   */
  spatial(position) {
    if (!position) return { gain: 1, pan: 0 };
    const offset = this._scratch.copy(position).sub(this.listenerPosition);
    const distance = offset.length();
    if (distance > MAX_AUDIBLE_DISTANCE) return null;
    // Linear-in-square rolloff: quiet quickly nearby, then a long soft tail.
    const attenuation = 1 - distance / MAX_AUDIBLE_DISTANCE;
    const pan = distance < 0.5 ? 0 : THREE.MathUtils.clamp(offset.dot(this.listenerRight) / distance, -1, 1);
    return { gain: attenuation * attenuation, pan: pan * 0.8 };
  }

  /**
   * Core voice: a slice of noise through a band-pass, with an optional sine
   * partial and pitch sweep, wrapped in an exponential envelope.
   */
  voice({ freq, q = 1, decay = 0.12, gain = 0.3, tone = 0, toneGain = 0.4, sweep = 0, rate = 1, pan = 0 }) {
    if (!this.context || !this.enabled || gain <= 0.0005) return;
    const ctx = this.context;
    const now = ctx.currentTime;

    const output = ctx.createGain();
    output.gain.setValueAtTime(0.0001, now);
    // A 4 ms attack instead of an instant one removes the click that a hard
    // gain step puts in front of every sound.
    output.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.004);
    output.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = pan;
      output.connect(panner);
      panner.connect(this.master);
    } else {
      output.connect(this.master);
    }

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, now);
    if (sweep !== 0) {
      const target = Math.max(60, freq * (1 + sweep));
      filter.frequency.exponentialRampToValueAtTime(target, now + decay);
    }
    filter.Q.value = q;
    filter.connect(output);

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = rate;
    // Random offset into the buffer so repeated sounds never phase-align.
    const offset = Math.random() * (this.noise.duration - decay - 0.05);
    source.connect(filter);
    source.start(now, Math.max(0, offset), decay + 0.05);
    source.stop(now + decay + 0.05);

    if (tone > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone * rate, now);
      if (sweep !== 0) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, tone * rate * (1 + sweep)), now + decay);
      }
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.0001, now);
      oscGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * toneGain), now + 0.006);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(oscGain);
      oscGain.connect(output);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    }
  }

  /**
   * Play a block sound.
   * @param {'dig'|'break'|'place'|'step'} action
   * @param {string} material  a block's `sound` group
   * @param {THREE.Vector3} [position]  world position, for attenuation and pan
   */
  block(action, material, position) {
    if (!this.context) return;
    const voice = MATERIALS[material] ?? MATERIALS.stone;
    const shape = ACTIONS[action] ?? ACTIONS.dig;
    const place = this.spatial(position);
    if (!place) return;

    const jitter = 1 + (Math.random() - 0.5) * 2 * shape.jitter;
    this.voice({
      freq: voice.freq * jitter,
      q: voice.q,
      decay: voice.decay * shape.length,
      gain: shape.gain * voice.gain * place.gain,
      tone: voice.tone,
      rate: shape.rate * jitter,
      pan: place.pan,
    });
  }

  /** Play one of the named non-block effects. */
  effect(name, { position, gain = 1, rate = 1 } = {}) {
    if (!this.context) return;
    const preset = EFFECTS[name];
    if (!preset) return;
    const place = this.spatial(position);
    if (!place) return;
    this.voice({
      ...preset,
      freq: preset.freq * rate,
      tone: (preset.tone ?? 0) * rate,
      gain: preset.gain * gain * place.gain,
      pan: place.pan,
    });
  }

  /** UI feedback, always centred and unattenuated. */
  ui(name = 'click') {
    if (!this.context) return;
    const preset = EFFECTS[name] ?? EFFECTS.click;
    this.voice({ ...preset });
  }

  dispose() {
    this.context?.close();
    this.context = null;
  }
}
