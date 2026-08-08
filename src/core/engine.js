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

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setPixelRatio(scale) {
    this.maxPixelRatio = scale;
    this.resize();
  }

  setRenderScale(scale) {
    this.renderScale = Math.max(0.25, Math.min(2, scale));
    this.resize();
  }

  setFov(degrees) {
    this.camera.fov = degrees;
    this.camera.updateProjectionMatrix();
  }

  setRenderDistance(chunks) {
    // Far plane sits just beyond the loaded radius; fog hides the boundary.
    this.camera.far = Math.max(200, chunks * 16 * 1.6);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * this.renderScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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
    this.renderer.dispose();
  }
}
