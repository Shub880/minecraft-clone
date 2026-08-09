/**
 * On-screen controls for touchscreens.
 *
 * A phone has no pointer to lock, no keyboard and no mouse buttons, so this
 * module supplies all three: a thumbstick that writes the player's analog
 * movement vector, a drag surface that turns the camera, and buttons that hold
 * the same *actions* the key bindings map to. Nothing downstream knows the
 * difference — `Player` reads `isDown('jump')` and `Interaction` reads
 * `isMouseDown(0)` exactly as they do on a desktop.
 *
 * The drag surface is where the feel is won or lost. One finger does three
 * jobs, told apart by time and distance:
 *
 *   move it            -> look around
 *   tap and release    -> place a block
 *   press and hold     -> mine, until the finger lifts
 *
 * That is the scheme every touch voxel game converges on, because it leaves
 * the second thumb free for movement. The thresholds below are the whole
 * design: too tight and a look-drag places blocks by accident, too loose and
 * placing feels unresponsive.
 */

import { el, clear } from './dom.js';

/** Movement, in pixels, past which a touch is a look rather than a tap. */
const TAP_SLOP = 14;
/** Seconds a stationary finger waits before it starts mining. */
const HOLD_DELAY = 0.18;
/** Longest a touch can last and still count as a tap. */
const TAP_DURATION = 0.4;

/** Stick travel, in pixels, for full deflection. */
const STICK_RADIUS = 52;
/** Deflection past which the stick also asks to sprint. */
const SPRINT_THRESHOLD = 0.92;
/** Deflection below which the stick reads as centred. */
const STICK_DEADZONE = 0.16;

/** Radians of look per pixel dragged, before the player's multiplier. */
const LOOK_SCALE = 0.0022;

/**
 * True when this device is driven by touch.
 *
 * `maxTouchPoints` alone reports true for touchscreen laptops that are mostly
 * used with a trackpad, so it is paired with a coarse-pointer query: together
 * they mean "touch is the primary way this screen is used".
 */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const points = navigator.maxTouchPoints ?? 0;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return points > 0 && coarse;
}

export class TouchControls {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root       the `#touch` container
   * @param {import('../core/input.js').Input} options.input
   * @param {import('../core/settings.js').Settings} options.settings
   * @param {import('../core/audio.js').AudioEngine} [options.audio]
   */
  constructor({ root, input, settings, audio }) {
    this.root = root;
    this.input = input;
    this.settings = settings;
    this.audio = audio;

    this.active = false;
    this.blocked = false;
    /** The running session, or null on the title screen. */
    this.game = null;

    /** Pointer currently driving the look surface. */
    this.look = null;
    /** Pointer currently driving the thumbstick. */
    this.stick = null;
    /** Buttons still to be released, keyed by pointer id. */
    this.heldButtons = new Map();
    /** Mouse buttons held for a fixed number of frames, keyed by button. */
    this.pulses = new Map();

    /** Called when the player asks for the pause menu. */
    this.onPause = null;

    this.build();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  build() {
    clear(this.root);
    this.root.classList.add('touch', 'hidden');

    this.surface = el('div.touch__surface');
    this.bindLookSurface(this.surface);

    this.stickKnob = el('div.touch__knob');
    this.stickBase = el('div.touch__stick', {}, [this.stickKnob]);
    this.stickZone = el('div.touch__stick-zone', {}, [this.stickBase]);
    this.bindStick(this.stickZone);

    this.jumpButton = this.actionButton('jump', 'Jump', ICONS.jump, { hold: 'jump', large: true });
    this.sneakButton = this.actionButton('sneak', 'Sneak', ICONS.sneak, { hold: 'sneak' });
    this.flyButton = this.actionButton('fly', 'Fly', ICONS.fly, { press: () => this.toggleFlight() });

    this.actions = el('div.touch__actions', {}, [
      this.flyButton,
      this.sneakButton,
      this.jumpButton,
    ]);

    /*
     * A row of five buttons across the top is a row of five buttons you are
     * looking through for the whole session. Only the toggle stays out; the
     * rest live in a tray that opens under it, acts, and folds away again.
     */
    this.tray = el('div.touch__tray', {}, [
      this.trayButton('inventory', 'Inventory', ICONS.bag, () => this.openOverlay('inventory')),
      this.trayButton('chat', 'Chat', ICONS.chat, () => this.openOverlay('chat')),
      this.trayButton('perspective', 'View', ICONS.eye, () => this.input.tap('perspective')),
      this.trayButton('fullscreen', 'Fullscreen', ICONS.expand, () => this.toggleFullscreen()),
      this.trayButton('pause', 'Menu', ICONS.pause, () => this.onPause?.()),
    ]);
    this.trayToggle = this.actionButton('more', 'More controls', ICONS.more, {
      press: () => this.toggleTray(),
    });
    this.menuButtons = el('div.touch__menu', {}, [this.tray, this.trayToggle]);
    /** Seconds left before an untouched tray folds itself away. */
    this.trayTimer = 0;

    this.root.append(this.surface, this.stickZone, this.actions, this.menuButtons);
  }

  /**
   * A button that either holds an action for as long as it is touched or fires
   * once on press. Pointer capture is what makes a held button survive a thumb
   * sliding off its edge mid-jump.
   */
  actionButton(name, label, icon, { hold = null, press = null, large = false } = {}) {
    const node = el(`button.touch__btn${large ? '.touch__btn--large' : ''}`, {
      type: 'button',
      'aria-label': label,
      dataset: { control: name },
      html: icon,
    });

    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      node.setPointerCapture?.(event.pointerId);
      node.classList.add('is-down');
      if (hold) {
        this.input.hold(hold);
        this.heldButtons.set(event.pointerId, { node, action: hold });
      }
      if (press) press();
    });

    const release = (event) => {
      const held = this.heldButtons.get(event.pointerId);
      if (held) {
        this.input.release(held.action);
        this.heldButtons.delete(event.pointerId);
      }
      node.classList.remove('is-down');
    };
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    // A button click must never also reach the look surface underneath.
    node.addEventListener('click', (event) => event.stopPropagation());

    return node;
  }

  /** A tray entry: does its job, then folds the tray away. */
  trayButton(name, label, icon, press) {
    return this.actionButton(name, label, icon, {
      press: () => {
        press();
        this.closeTray();
      },
    });
  }

  toggleTray() {
    if (this.trayOpen) this.closeTray();
    else this.openTray();
  }

  openTray() {
    this.trayOpen = true;
    this.menuButtons.classList.add('is-open');
    // Long enough to read the icons and choose, short enough that a tray
    // opened by accident does not stay in the way.
    this.trayTimer = 6;
  }

  closeTray() {
    if (!this.trayOpen) return;
    this.trayOpen = false;
    this.menuButtons.classList.remove('is-open');
    this.trayTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Look, mine and place
  // -------------------------------------------------------------------------

  bindLookSurface(node) {
    node.addEventListener('contextmenu', (event) => event.preventDefault());

    node.addEventListener('pointerdown', (event) => {
      // One finger owns the camera; a second one on the same surface is
      // ignored rather than fighting it for the delta.
      if (this.look || !this.input.enabled) return;
      event.preventDefault();
      node.setPointerCapture?.(event.pointerId);
      this.look = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        travelled: 0,
        age: 0,
        stillFor: 0,
        mining: false,
      };
      this.input.lookDragging = true;
    });

    node.addEventListener('pointermove', (event) => {
      const look = this.look;
      if (!look || event.pointerId !== look.id) return;
      event.preventDefault();
      if (!this.input.enabled) return;

      const dx = event.clientX - look.x;
      const dy = event.clientY - look.y;
      look.x = event.clientX;
      look.y = event.clientY;

      const moved = Math.hypot(dx, dy);
      look.travelled += moved;
      // Only real movement resets the hold timer. Without the threshold the
      // jitter of a resting thumb would keep mining from ever starting.
      if (moved > 0.7) look.stillFor = 0;

      const scale = LOOK_SCALE * (this.settings.get('touchSensitivity') ?? 3);
      this.input.addLook(-dx * scale, -dy * scale);
    });

    const end = (event) => {
      const look = this.look;
      if (!look || event.pointerId !== look.id) return;
      this.look = null;
      this.input.lookDragging = false;

      if (look.mining) {
        this.input.setVirtualButton(0, false);
        return;
      }
      // A quick, still touch is a tap: place a block. Held for two frames so
      // the game loop cannot miss it between updates.
      if (look.travelled < TAP_SLOP && look.age < TAP_DURATION) this.pulse(2, 2);
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }

  /** Hold a mouse button for a fixed number of frames. */
  pulse(button, frames) {
    this.input.setVirtualButton(button, true);
    this.pulses.set(button, frames);
  }

  // -------------------------------------------------------------------------
  // Thumbstick
  // -------------------------------------------------------------------------

  bindStick(zone) {
    zone.addEventListener('pointerdown', (event) => {
      if (this.stick) return;
      event.preventDefault();
      event.stopPropagation();
      zone.setPointerCapture?.(event.pointerId);

      // The base re-centres under the thumb, so the stick is wherever the
      // player reached rather than somewhere they have to find first. Clamped
      // inside the zone so a touch at the very corner still leaves room for a
      // full deflection in every direction.
      const bounds = zone.getBoundingClientRect();
      const margin = STICK_RADIUS + 12;
      const originX = clamp(event.clientX - bounds.left, margin, bounds.width - margin);
      const originY = clamp(event.clientY - bounds.top, margin, bounds.height - margin);
      this.stick = { id: event.pointerId, originX: bounds.left + originX, originY: bounds.top + originY };

      // The base is positioned by its centre, so these are the centre point.
      this.stickBase.style.left = `${originX}px`;
      this.stickBase.style.top = `${originY}px`;
      this.stickBase.classList.add('is-active');
      this.moveStick(event.clientX, event.clientY);
    });

    zone.addEventListener('pointermove', (event) => {
      if (!this.stick || event.pointerId !== this.stick.id) return;
      event.preventDefault();
      this.moveStick(event.clientX, event.clientY);
    });

    const end = (event) => {
      if (!this.stick || event.pointerId !== this.stick.id) return;
      this.stick = null;
      this.stickBase.classList.remove('is-active');
      this.stickBase.style.left = '';
      this.stickBase.style.top = '';
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
      this.input.setMoveAxis(0, 0);
      this.input.release('sprint');
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  moveStick(clientX, clientY) {
    const stick = this.stick;
    if (!stick) return;

    const dx = clientX - stick.originX;
    const dy = clientY - stick.originY;
    const distance = Math.hypot(dx, dy);
    const capped = Math.min(distance, STICK_RADIUS);
    const angle = distance > 0 ? Math.atan2(dy, dx) : 0;

    const knobX = Math.cos(angle) * capped;
    const knobY = Math.sin(angle) * capped;
    this.stickKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;

    const deflection = capped / STICK_RADIUS;
    if (deflection < STICK_DEADZONE) {
      this.input.setMoveAxis(0, 0);
      this.input.release('sprint');
      return;
    }

    // Rescale past the deadzone so the first millimetre of real movement is a
    // crawl rather than a jump to a quarter speed.
    const magnitude = (deflection - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    this.input.setMoveAxis(Math.cos(angle) * magnitude, -Math.sin(angle) * magnitude);

    if (deflection > SPRINT_THRESHOLD) this.input.hold('sprint');
    else this.input.release('sprint');
  }

  // -------------------------------------------------------------------------
  // Buttons that need game state
  // -------------------------------------------------------------------------

  /**
   * Flight has no touch equivalent of double-tapping jump, so it gets a
   * button. Outside creative there is nothing to toggle, and the button is
   * hidden rather than left to do nothing.
   */
  toggleFlight() {
    const player = this.game?.player;
    if (!player || player.gameMode === 'survival') return;
    player.flying = !player.flying;
    if (player.flying) player.velocity.y = 0;
    player.fallDistance = 0;
    this.flyButton.classList.toggle('is-on', player.flying);
    this.game?.hud?.toast(player.flying ? 'Flying' : 'Walking', { seconds: 1.2 });
  }

  /**
   * Open an overlay from inside the touch handler rather than queueing a
   * virtual key press.
   *
   * Mobile browsers only raise the keyboard for a `focus()` that happens
   * during a real user gesture. Routing chat through the input queue would put
   * the focus call a frame later, in an animation callback, and the field
   * would open with no keyboard under it.
   */
  openOverlay(which) {
    const game = this.game;
    if (!game) return;
    if (which === 'chat') game.openChat('');
    else game.openInventory();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    const request = document.documentElement.requestFullscreen?.();
    // Landscape is the only sensible orientation for a first-person game, and
    // the lock is only permitted from inside a fullscreen request.
    request?.then?.(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.root.classList.toggle('hidden', !active);
    // The camera is touch-driven for as long as the controls are up, not only
    // while a finger is down. Flipping this per drag would leave the last few
    // pixels of a swipe unconsumed, to be applied as a jolt at the start of
    // the next one.
    this.input.touchLook = active;
    if (!active) this.releaseEverything();
  }

  /** Point the controls at a running session, or `null` on the title screen. */
  attach(game) {
    this.game = game;
    if (!game) this.releaseEverything();
    this.refreshAvailability();
  }

  /** Drop every held input, so nothing is stuck down when the layer hides. */
  releaseEverything() {
    this.look = null;
    this.stick = null;
    this.heldButtons.clear();
    this.pulses.clear();
    this.input.lookDragging = false;
    this.input.clearVirtual();
    this.closeTray();
    this.stickBase.classList.remove('is-active');
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    for (const node of this.root.querySelectorAll('.is-down')) node.classList.remove('is-down');
  }

  /** Show only the buttons that mean something in the current game mode. */
  refreshAvailability() {
    const mode = this.game?.player?.gameMode;
    const canFly = mode === 'creative' || mode === 'spectator';
    const flying = Boolean(this.game?.player?.flying);
    if (canFly === this._canFly && flying === this._flying) return;
    this._canFly = canFly;
    this._flying = flying;
    this.flyButton.classList.toggle('hidden', !canFly);
    this.flyButton.classList.toggle('is-on', flying);
  }

  /**
   * Per-frame bookkeeping: expire button pulses, and promote a stationary
   * finger into a mining hold.
   */
  update(delta) {
    if (!this.active) return;

    for (const [button, frames] of this.pulses) {
      if (frames > 1) {
        this.pulses.set(button, frames - 1);
        continue;
      }
      this.pulses.delete(button);
      this.input.setVirtualButton(button, false);
    }

    // A finger that has come to rest starts mining, whether it arrived there
    // by tapping or by dragging the camera onto the block first. Aiming and
    // then digging is one continuous gesture that way, instead of two.
    const look = this.look;
    if (look && !look.mining) {
      look.age += delta;
      look.stillFor += delta;
      if (look.stillFor >= HOLD_DELAY) {
        look.mining = true;
        this.input.setVirtualButton(0, true);
      }
    }

    if (this.trayOpen) {
      this.trayTimer -= delta;
      if (this.trayTimer <= 0) this.closeTray();
    }

    this.refreshAvailability();
  }

  /** Hide the controls while a menu or overlay owns the screen. */
  setBlocked(blocked) {
    // Called every frame, so it has to be free when nothing has changed.
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.root.classList.toggle('is-blocked', blocked);
    if (blocked) this.releaseEverything();
  }
}

function clamp(value, min, max) {
  if (max < min) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}

/** Inline so the controls never wait on a network request to become usable. */
const ICONS = {
  more: svg('<circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/>'),
  jump: svg('<path d="M12 4l7 8h-4v8h-6v-8H5z"/>'),
  sneak: svg('<path d="M12 20l-7-8h4V4h6v8h4z"/>'),
  fly: svg('<path d="M3 13c4-6 14-6 18 0-4-2-6-1-9 2-3-3-5-4-9-2z"/><circle cx="12" cy="7" r="2.4"/>'),
  pause: svg('<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>'),
  bag: svg('<path d="M6 8h12l-1 12H7zM9 8V6a3 3 0 0 1 6 0v2h-2V6a1 1 0 0 0-2 0v2z"/>'),
  chat: svg('<path d="M4 5h16v10H9l-5 4z"/>'),
  eye: svg('<path d="M12 6c5 0 8 4.2 9 6-1 1.8-4 6-9 6s-8-4.2-9-6c1-1.8 4-6 9-6zm0 3.2A2.8 2.8 0 1 0 12 15a2.8 2.8 0 0 0 0-5.8z"/>'),
  expand: svg('<path d="M4 4h6v2.4H6.4V10H4zm10 0h6v6h-2.4V6.4H14zM4 14h2.4v3.6H10V20H4zm13.6 0H20v6h-6v-2.4h3.6z"/>'),
};

function svg(body) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">${body}</svg>`;
}
