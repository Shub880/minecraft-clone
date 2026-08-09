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

    /**
     * Actions held by something other than a key — the on-screen controls.
     * Kept as actions rather than synthetic key codes so a rebound key never
     * changes what a touch button does.
     * @type {Set<string>}
     */
    this.virtual = new Set();
    /**
     * Analog movement, -1..1. `x` strafes right, `y` walks forward. A stick
     * pushed halfway should walk at half speed, which a key set cannot express,
     * so this rides alongside the bindings rather than through them.
     */
    this.moveAxis = { x: 0, y: 0 };
    /** True while the on-screen controls are driving the camera. */
    this.touchLook = false;
    /**
     * Look delta already converted to radians, for sources that carry their own
     * sensitivity. A finger drag and a mouse move want different scaling, and
     * running both through one multiplier makes tuning either one break the
     * other.
     */
    this.lookYaw = 0;
    this.lookPitch = 0;

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
      this.virtual.clear();
      this.moveAxis.x = 0;
      this.moveAxis.y = 0;
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
    if (this.virtual.has(action)) return true;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const code of codes) {
      if (this.pressed.has(code)) return true;
    }
    return false;
  }

  /**
   * True while the player is steering the view, by pointer lock or by touch.
   * The distinction matters: a phone has no pointer to lock, but the camera
   * still has to turn.
   */
  get lookActive() {
    return this.locked || this.touchLook;
  }

  /** Hold an action from an on-screen control. */
  hold(action) {
    if (this.virtual.has(action)) return;
    this.virtual.add(action);
    this.justPressed.add(action);
  }

  /** Release an action held by an on-screen control. */
  release(action) {
    this.virtual.delete(action);
  }

  /** Fire a one-frame press, for buttons that toggle rather than hold. */
  tap(action) {
    this.justPressed.add(action);
  }

  /** Set the analog movement vector, clamped to the unit disc. */
  setMoveAxis(x, y) {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    const length = Math.hypot(safeX, safeY);
    const scale = length > 1 ? 1 / length : 1;
    this.moveAxis.x = safeX * scale;
    this.moveAxis.y = safeY * scale;
  }

  /** Press or release a mouse button from an on-screen control. */
  setVirtualButton(button, down) {
    if (down) {
      if (!this.mouseButtons.has(button)) this.justClicked.add(button);
      this.mouseButtons.add(button);
    } else {
      this.mouseButtons.delete(button);
    }
  }

  /** Drop everything the on-screen controls are holding. */
  clearVirtual() {
    this.virtual.clear();
    this.moveAxis.x = 0;
    this.moveAxis.y = 0;
    this.mouseButtons.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
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
    // A non-finite sensitivity or delta would make the camera's rotation NaN,
    // and every frame after that renders an empty scene. Cheaper to refuse the
    // bad value here than to detect a black screen later.
    const sensitivity = Number.isFinite(this.sensitivity) ? this.sensitivity : 0.0022;
    const dx = Number.isFinite(this.mouseDeltaX) ? this.mouseDeltaX : 0;
    const dy = Number.isFinite(this.mouseDeltaY) ? this.mouseDeltaY : 0;
    const extraYaw = Number.isFinite(this.lookYaw) ? this.lookYaw : 0;
    const extraPitch = Number.isFinite(this.lookPitch) ? this.lookPitch : 0;
    const yaw = -dx * sensitivity + extraYaw;
    const pitch = (-dy * sensitivity + extraPitch) * sign;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    return { yaw, pitch };
  }

  /** Add an already-scaled look delta, in radians. */
  addLook(yaw, pitch) {
    if (Number.isFinite(yaw)) this.lookYaw += yaw;
    if (Number.isFinite(pitch)) this.lookPitch += pitch;
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
    // Nothing to lock when the camera is driven by touch, and asking anyway
    // puts a permission prompt over the game on a phone.
    if (this.touchLook) return;
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
