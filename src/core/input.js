/**
 * Keyboard and mouse input.
 *
 * Actions are bound to `KeyboardEvent.code` values rather than `key`, so the
 * bindings work the same on every keyboard layout and can be rebound from the
 * settings screen without ambiguity.
 */

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sneak: ['ShiftLeft', 'ShiftRight'],
  sprint: ['ControlLeft', 'KeyR'],
  inventory: ['KeyE'],
  drop: ['KeyQ'],
  chat: ['KeyT'],
  command: ['Slash'],
  debug: ['F3'],
  screenshot: ['F2'],
  perspective: ['F5'],
  pause: ['Escape'],
  fullscreen: ['F11'],
};

export class Input {
  constructor(domElement) {
    this.domElement = domElement;
    this.bindings = structuredClone(DEFAULT_BINDINGS);

    this.pressed = new Set();
    /** Actions that went down this frame, cleared by `endFrame`. */
    this.justPressed = new Set();
    this.mouseButtons = new Set();
    this.justClicked = new Set();

    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
    this.sensitivity = 0.0022;
    this.invertY = false;

    this.locked = false;
    this.enabled = true;

    /** Consumers can subscribe to raw key events for UI shortcuts. */
    this.listeners = new Set();

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (event) => {
      if (this._isTypingTarget(event.target)) return;
      // Browser defaults for the function keys we use would be disruptive.
      // F11 is handled here too, so the game's own fullscreen toggle does not
      // fight the browser's and cancel itself out.
      if (['F2', 'F3', 'F5', 'F11'].includes(event.code)) event.preventDefault();
      if (event.code === 'Space') event.preventDefault();
      if (event.repeat) return;
      this.pressed.add(event.code);
      for (const action of this._actionsFor(event.code)) this.justPressed.add(action);
      for (const listener of this.listeners) listener(event.code, true, event);
    });

    window.addEventListener('keyup', (event) => {
      this.pressed.delete(event.code);
      for (const listener of this.listeners) listener(event.code, false, event);
    });

    // A lost window means every key is stuck down otherwise.
    window.addEventListener('blur', () => {
      this.pressed.clear();
      this.mouseButtons.clear();
    });

    this.domElement.addEventListener('mousedown', (event) => {
      if (!this.locked) return;
      this.mouseButtons.add(event.button);
      this.justClicked.add(event.button);
    });

    window.addEventListener('mouseup', (event) => {
      this.mouseButtons.delete(event.button);
    });

    this.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

    document.addEventListener('mousemove', (event) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDeltaX += event.movementX || 0;
      this.mouseDeltaY += event.movementY || 0;
    });

    this.domElement.addEventListener('wheel', (event) => {
      if (!this.locked) return;
      event.preventDefault();
      this.wheelDelta += Math.sign(event.deltaY);
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.domElement;
      if (!this.locked) {
        this.pressed.clear();
        this.mouseButtons.clear();
        this.onPointerUnlock?.();
      }
    });
  }

  _isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  _actionsFor(code) {
    const actions = [];
    for (const [action, codes] of Object.entries(this.bindings)) {
      if (codes.includes(code)) actions.push(action);
    }
    return actions;
  }

  /** Rebind an action to a single key code. */
  rebind(action, code) {
    this.bindings[action] = [code];
  }

  isDown(action) {
    if (!this.enabled) return false;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const code of codes) {
      if (this.pressed.has(code)) return true;
    }
    return false;
  }

  wasPressed(action) {
    return this.justPressed.has(action);
  }

  isMouseDown(button) {
    return this.enabled && this.mouseButtons.has(button);
  }

  wasClicked(button) {
    return this.justClicked.has(button);
  }

  /** Read and clear the accumulated look delta, in radians. */
  takeLook() {
    const sign = this.invertY ? -1 : 1;
    const yaw = -this.mouseDeltaX * this.sensitivity;
    const pitch = -this.mouseDeltaY * this.sensitivity * sign;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { yaw, pitch };
  }

  takeWheel() {
    const value = this.wheelDelta;
    this.wheelDelta = 0;
    return value;
  }

  /** Clear per-frame edge state. Call once at the end of every frame. */
  endFrame() {
    this.justPressed.clear();
    this.justClicked.clear();
  }

  requestLock() {
    // Modern browsers return a promise that rejects when the lock is refused —
    // too soon after an Escape, or the document is not focused. That is a
    // normal outcome, not an error, so it must not surface as an unhandled
    // rejection; the player simply clicks again.
    const request = this.domElement.requestPointerLock?.();
    request?.catch?.(() => {});
  }

  releaseLock() {
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }
}
