/**
 * Renderer, camera and scene setup, plus the frame timing helpers the rest of
 * the game reads.
 */

import * as THREE from 'three';

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping keeps the bright sunset sky and glowing lava from clipping
    // to flat white, which is most of what separates this from a flat render.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = true;
    // A frame is more than one render pass — the world, then the held-item
    // view model. Left on auto, the stats would reset between them and report
    // only whatever the last pass drew.
    this.renderer.info.autoReset = false;

    this.maxPixelRatio = 2;
    /**
     * Multiplier applied on top of the device pixel ratio. Below 1 this renders
     * at a lower resolution and lets the browser upscale, which is the single
     * most effective quality dial on a weak GPU.
     */
    this.renderScale = 1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 1400);
    this.camera.rotation.order = 'YXZ';

    this.clock = new THREE.Clock();
    this.elapsed = 0;

    // Rolling frame-time history for the debug overlay's graph.
    this.frameTimes = new Float32Array(120);
    this.frameCursor = 0;
    this.fps = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;

    /**
     * Last viewport the camera and drawing buffer were configured for. Kept so
     * a resize that reports a zero-sized viewport can be ignored outright
     * rather than dividing by it.
     */
    this.viewportWidth = 0;
    this.viewportHeight = 0;

    this.resize();

    // Two sources, because neither alone is reliable. `resize` misses layout
    // changes that do not change the window (a phone's URL bar collapsing),
    // and the observer does not fire for a device-pixel-ratio change.
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) this.resize(box.width, box.height);
        else this.resize();
      });
      this.observer.observe(canvas);
    }

    this.bindContextEvents();
  }

  /**
   * A lost GPU context makes every draw a silent no-op, which on screen is
   * indistinguishable from a broken game. Say so instead, and pick the world
   * back up if the browser hands the context back.
   */
  bindContextEvents() {
    this.contextLost = false;
    /** Set by the shell so it can rebuild what the GPU dropped. */
    this.onContextLost = null;
    this.onContextRestored = null;

    this.canvas.addEventListener('webglcontextlost', (event) => {
      // Without this the browser never attempts a restore.
      event.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.resize();
      this.onContextRestored?.();
    });
  }

  setPixelRatio(scale) {
    this.maxPixelRatio = scale;
    this.resize();
  }

  /**
   * Hand tone mapping over to the post-processing chain, or take it back.
   *
   * Only one of the two may do it. With the chain running, the scene is
   * rendered into a floating-point buffer and has to stay linear until the
   * composite; tone mapping on the way in would clip the highlights that the
   * bloom and sun shafts exist to find. Flipping this recompiles every
   * material once, which is why it is a setting rather than a per-frame call.
   */
  setToneMapping(enabled) {
    const next = enabled ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    if (this.renderer.toneMapping === next) return;
    this.renderer.toneMapping = next;
  }

  /** Size of the actual drawing buffer, in device pixels. */
  getDrawingBufferSize(out = new THREE.Vector2()) {
    return this.renderer.getDrawingBufferSize(out);
  }

  setRenderScale(scale) {
    this.renderScale = Math.max(0.25, Math.min(2, scale));
    this.resize();
  }

  setFov(degrees) {
    // A non-finite field of view poisons the projection matrix, and every
    // later frame culls to nothing — a black screen with a working HUD.
    if (!Number.isFinite(degrees)) return;
    this.camera.fov = Math.min(179, Math.max(1, degrees));
    this.camera.updateProjectionMatrix();
  }

  setRenderDistance(chunks) {
    const radius = Number.isFinite(chunks) ? chunks : 8;
    // Far plane sits just beyond the loaded radius; fog hides the boundary.
    this.camera.far = Math.max(200, radius * 16 * 1.6);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Match the drawing buffer and camera to the viewport.
   *
   * A minimised window, a hidden tab and some fullscreen transitions all
   * report a zero-sized viewport, and `width / 0` is what turns the camera's
   * projection matrix into NaN. Once that happens every subsequent frame
   * frustum-culls the entire scene — including the sky dome — and the world
   * goes black for good, because nothing recomputes the matrix afterwards.
   * So a measurement that cannot produce a usable aspect ratio is discarded
   * and the last good one is kept until a real one arrives.
   */
  resize(measuredWidth, measuredHeight) {
    const width = Math.floor(pickSize(measuredWidth, this.canvas.clientWidth, window.innerWidth));
    const height = Math.floor(pickSize(measuredHeight, this.canvas.clientHeight, window.innerHeight));
    if (width < 1 || height < 1) return;
    if (width === this.viewportWidth && height === this.viewportHeight
        && this.appliedRatio === this.pixelRatio) {
      return;
    }

    this.viewportWidth = width;
    this.viewportHeight = height;
    this.appliedRatio = this.pixelRatio;

    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  get pixelRatio() {
    const device = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
    return Math.min(device, this.maxPixelRatio) * this.renderScale;
  }

  /**
   * Last line of defence for the camera.
   *
   * Anything that leaves a non-finite number in the camera's transform or
   * projection renders an empty frame forever after, and the player has no way
   * to tell that from a crash. Checking six numbers once a frame is cheap
   * insurance, and repairing in place means a glitch costs a frame rather than
   * the session.
   */
  ensureViewIsFinite() {
    const camera = this.camera;
    const finite = Number.isFinite(camera.aspect) && camera.aspect > 0
      && Number.isFinite(camera.fov) && camera.fov > 0
      && Number.isFinite(camera.near) && Number.isFinite(camera.far)
      && Number.isFinite(camera.position.x)
      && Number.isFinite(camera.position.y)
      && Number.isFinite(camera.position.z)
      && Number.isFinite(camera.rotation.x)
      && Number.isFinite(camera.rotation.y)
      && Number.isFinite(camera.rotation.z);
    if (finite) return true;

    const width = this.viewportWidth || this.canvas.clientWidth || window.innerWidth || 1;
    const height = this.viewportHeight || this.canvas.clientHeight || window.innerHeight || 1;
    camera.aspect = Math.max(0.05, width / Math.max(1, height));
    if (!Number.isFinite(camera.fov) || camera.fov <= 0) camera.fov = 75;
    if (!Number.isFinite(camera.near) || camera.near <= 0) camera.near = 0.08;
    if (!Number.isFinite(camera.far) || camera.far <= camera.near) camera.far = 1400;
    if (!camera.position.toArray().every(Number.isFinite)) camera.position.set(0, 80, 0);
    if (!Number.isFinite(camera.rotation.x)) camera.rotation.x = 0;
    if (!Number.isFinite(camera.rotation.y)) camera.rotation.y = 0;
    if (!Number.isFinite(camera.rotation.z)) camera.rotation.z = 0;
    camera.updateProjectionMatrix();
    return false;
  }

  /** Seconds since the last frame, clamped so a stall does not teleport the player. */
  tick() {
    const raw = this.clock.getDelta();
    const delta = Math.min(raw, 0.1);
    this.elapsed += delta;

    this.frameTimes[this.frameCursor] = raw * 1000;
    this.frameCursor = (this.frameCursor + 1) % this.frameTimes.length;

    // Measured against real time, not the clamped delta. Using the clamped
    // value would peg the counter at exactly 1/clamp on any machine slower
    // than that, reporting a healthy frame rate for a slideshow.
    this._fpsAccumulator += raw;
    this._fpsFrames++;
    if (this._fpsAccumulator >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccumulator);
      this._fpsAccumulator = 0;
      this._fpsFrames = 0;
    }

    return delta;
  }

  /** Mean frame time in milliseconds over the rolling history. */
  get frameTime() {
    let sum = 0;
    for (let i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
    return sum / this.frameTimes.length;
  }

  /**
   * Draw the world. Cleared stats accumulate from here through any overlay
   * passes that follow, so `drawCalls` and `triangles` describe a whole frame.
   * They are read by the debug overlay a frame later, which is exactly right —
   * reading them mid-frame would report a partial total.
   */
  render() {
    if (this.contextLost) return;
    this.ensureViewIsFinite();
    this.renderer.info.reset();
    // A buffer clear is subject to the current write masks, and the automatic
    // clear inside `render` does not reset them. The last material drawn last
    // frame may well have had `depthWrite: false` (particles, the block
    // break overlay), which would silently turn this frame's depth clear into
    // a no-op and leave stale depth behind.
    this.renderer.state.buffers.depth.setMask(true);
    this.renderer.state.buffers.color.setMask(true);
    this.renderer.render(this.scene, this.camera);
  }

  get drawCalls() {
    return this.renderer.info.render.calls;
  }

  get triangles() {
    return this.renderer.info.render.triangles;
  }

  dispose() {
    this.observer?.disconnect();
    this.renderer.dispose();
  }
}

/** First usable size from a measurement and its fallbacks. */
function pickSize(...candidates) {
  for (const value of candidates) {
    if (Number.isFinite(value) && value >= 1) return value;
  }
  return 0;
}
