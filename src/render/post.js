/**
 * Post-processing: bloom, god rays, tone mapping and vignette.
 *
 * The world is rendered into a floating-point buffer instead of straight to the
 * screen, which is what makes the rest of this possible: colours are allowed to
 * go past white — the sun disc, glowstone, sunlight on water — and the passes
 * below get to see *how far* past. Clipping to white first, the way a direct
 * render does, throws that information away and there is nothing left to bloom.
 *
 * The chain is deliberately short and cheap:
 *
 *   bright    everything above a threshold, at quarter resolution
 *   blur      three widening separable passes over that
 *   rays      a radial blur of the same bright buffer, away from the sun
 *   composite scene + bloom + rays, exposed, tone mapped, vignetted
 *
 * God rays are the reason the bright buffer is reused rather than the scene:
 * shafts should be cast by the sky where it is visible and stopped by anything
 * solid, and a bright-pass buffer is exactly "sky, and nothing else".
 *
 * Tone mapping lives here rather than on the renderer. With this pipeline on,
 * `renderer.toneMapping` is switched off so the scene stays linear all the way
 * to the composite, where ACES is applied once at the end.
 */

import * as THREE from 'three';

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  void main() {
    vec3 color = texture(uScene, vUv).rgb;
    float brightness = max(color.r, max(color.g, color.b));
    // Soft knee: fade in over a band around the threshold instead of clipping,
    // so a surface drifting past it brightens rather than pops.
    float contribution = smoothstep(uThreshold, uThreshold + uKnee, brightness);
    gl_FragColor = vec4(color * contribution, 1.0);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uDirection;
  varying vec2 vUv;

  void main() {
    // Nine-tap gaussian folded into five samples by landing each one between
    // two texels and letting bilinear filtering average them.
    vec4 sum = texture(uSource, vUv) * 0.227027;
    vec2 o1 = uDirection * 1.3846153846;
    vec2 o2 = uDirection * 3.2307692308;
    sum += texture(uSource, vUv + o1) * 0.3162162162;
    sum += texture(uSource, vUv - o1) * 0.3162162162;
    sum += texture(uSource, vUv + o2) * 0.0702702703;
    sum += texture(uSource, vUv - o2) * 0.0702702703;
    gl_FragColor = sum;
  }
`;

const RAYS_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uSunUv;
  uniform float uDensity;
  uniform float uDecay;
  uniform float uWeight;
  varying vec2 vUv;

  const int SAMPLES = 28;

  void main() {
    vec2 coord = vUv;
    // "sample" and "step" are both reserved in GLSL ES 3, hence the naming.
    vec2 stride = (vUv - uSunUv) * (uDensity / float(SAMPLES));
    float illumination = 1.0;
    vec3 sum = vec3(0.0);

    for (int i = 0; i < SAMPLES; i++) {
      coord -= stride;
      // Marching outside the frame would smear the edge pixels inward as if
      // the sky continued past the screen.
      vec3 tap = texture(uSource, clamp(coord, 0.0, 1.0)).rgb;
      sum += tap * illumination;
      illumination *= uDecay;
    }

    gl_FragColor = vec4(sum * uWeight / float(SAMPLES), 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform sampler2D uRays;
  uniform vec3 uRayColor;
  uniform float uBloomStrength;
  uniform float uRayStrength;
  uniform float uExposure;
  uniform float uVignette;
  uniform float uSaturation;
  uniform float uUnderwater;

  varying vec2 vUv;

  /**
   * ACES filmic, Narkowicz's fit. Chosen over Reinhard because it keeps a
   * blown-out sky warm instead of washing it to grey, which is exactly what a
   * bright sun over green ground needs.
   */
  vec3 acesFilmic(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    vec3 color = texture(uScene, vUv).rgb;

    color += texture(uBloom, vUv).rgb * uBloomStrength;
    color += texture(uRays, vUv).rgb * uRayColor * uRayStrength;

    color *= uExposure;
    color = acesFilmic(color);

    // A touch of saturation back, since tone mapping always takes some out.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);

    // Vignette, and a stronger one underwater where the eye should be drawn in.
    vec2 centred = vUv - 0.5;
    float falloff = 1.0 - dot(centred, centred) * (uVignette + uUnderwater * 0.9);
    color *= clamp(falloff, 0.0, 1.0);

    gl_FragColor = vec4(color, 1.0);

    #include <colorspace_fragment>
  }
`;

/** Fraction of the drawing buffer the bloom and ray buffers run at. */
const HALF = 0.5;
const QUARTER = 0.25;

export class PostProcessing {
  constructor() {
    this.enabled = true;
    this.bloomStrength = 0.75;
    this.rayStrength = 0.7;
    this.exposure = 1;
    this.vignette = 0.55;
    this.saturation = 1.18;

    this.width = 1;
    this.height = 1;

    this.scene = new THREE.Scene();
    // A single triangle would save a few pixels of overdraw; a quad is clearer
    // and the difference is unmeasurable at this size.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.sceneTarget = makeTarget(1, 1, THREE.HalfFloatType, true);
    this.bright = makeTarget(1, 1, THREE.HalfFloatType, false);
    this.blurA = makeTarget(1, 1, THREE.HalfFloatType, false);
    this.blurB = makeTarget(1, 1, THREE.HalfFloatType, false);
    this.rays = makeTarget(1, 1, THREE.HalfFloatType, false);

    this.brightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: null },
        // High enough that only the sun, glowing blocks and sunlight on water
        // cross it. Lower, and ordinary lit ground starts to glow, which reads
        // as a lens problem rather than as brightness.
        uThreshold: { value: 1.25 },
        uKnee: { value: 0.6 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: null },
        uDirection: { value: new THREE.Vector2() },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.rayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: null },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uDensity: { value: 0.85 },
        uDecay: { value: 0.955 },
        uWeight: { value: 5.6 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: RAYS_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    // The composite is the pass that writes to the canvas, so it is the only
    // one that includes the output colour-space conversion.
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: null },
        uBloom: { value: null },
        uRays: { value: null },
        uRayColor: { value: new THREE.Vector3(1, 0.9, 0.75) },
        uBloomStrength: { value: this.bloomStrength },
        uRayStrength: { value: 0 },
        uExposure: { value: 1 },
        uVignette: { value: this.vignette },
        uSaturation: { value: this.saturation },
        uUnderwater: { value: 0 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this._sunWorld = new THREE.Vector3();
  }

  /** Match every buffer to the drawing buffer. */
  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    this.sceneTarget.setSize(w, h);
    this.bright.setSize(Math.max(1, Math.floor(w * QUARTER)), Math.max(1, Math.floor(h * QUARTER)));
    this.blurA.setSize(Math.max(1, Math.floor(w * QUARTER)), Math.max(1, Math.floor(h * QUARTER)));
    this.blurB.setSize(Math.max(1, Math.floor(w * QUARTER)), Math.max(1, Math.floor(h * QUARTER)));
    this.rays.setSize(Math.max(1, Math.floor(w * HALF)), Math.max(1, Math.floor(h * HALF)));
  }

  /**
   * Point the renderer at the scene buffer. Everything drawn between this and
   * `render` — the world, then the held item — lands in the same buffer and is
   * graded together.
   */
  begin(renderer) {
    renderer.setRenderTarget(this.sceneTarget);
  }

  /**
   * Work out where the sun is on screen, and how strongly it should throw
   * shafts from there.
   *
   * Returns 0 when the sun is behind the camera or below the horizon: a radial
   * blur toward an off-screen point still produces streaks, and they point the
   * wrong way, which reads as a rendering fault rather than as light.
   */
  updateSun(camera, sky) {
    const uv = this.rayMaterial.uniforms.uSunUv.value;
    if (sky.sunDirection.y < -0.02) return 0;

    this._sunWorld.copy(camera.position).addScaledVector(sky.sunDirection, 500);
    this._sunWorld.project(camera);
    if (this._sunWorld.z > 1) return 0;

    uv.set(this._sunWorld.x * 0.5 + 0.5, this._sunWorld.y * 0.5 + 0.5);

    // Fade with distance from the middle of the screen, and again as the sun
    // sinks, so shafts arrive when you look toward it and never at midnight.
    const offset = Math.hypot(uv.x - 0.5, uv.y - 0.5);
    const centred = 1 - smoothstep(0.35, 1.15, offset);
    const elevation = smoothstep(-0.02, 0.14, sky.sunDirection.y);
    return centred * elevation;
  }

  /**
   * Run the chain and put the result on screen.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {import('./sky.js').Sky} sky
   * @param {number} underwater  0..1, for the extra vignette below the surface
   */
  render(renderer, camera, sky, underwater = 0) {
    const rayVisibility = this.rayStrength > 0 ? this.updateSun(camera, sky) : 0;
    const wantsBloom = this.bloomStrength > 0;
    const wantsRays = rayVisibility > 0;

    if (wantsBloom || wantsRays) {
      this.brightMaterial.uniforms.uScene.value = this.sceneTarget.texture;
      this.draw(renderer, this.brightMaterial, this.bright);
    }

    if (wantsBloom) {
      // Three widening passes: each doubles its step, so the last one reaches
      // far enough to read as a glow rather than as a blurred copy.
      let source = this.bright;
      for (let pass = 0; pass < 3; pass++) {
        const spread = 1 + pass * 1.9;
        this.blurMaterial.uniforms.uSource.value = source.texture;
        this.blurMaterial.uniforms.uDirection.value.set(spread / this.bright.width, 0);
        this.draw(renderer, this.blurMaterial, this.blurA);

        this.blurMaterial.uniforms.uSource.value = this.blurA.texture;
        this.blurMaterial.uniforms.uDirection.value.set(0, spread / this.bright.height);
        this.draw(renderer, this.blurMaterial, this.blurB);
        source = this.blurB;
      }
    }

    if (wantsRays) {
      this.rayMaterial.uniforms.uSource.value = this.bright.texture;
      this.draw(renderer, this.rayMaterial, this.rays);
    }

    const uniforms = this.compositeMaterial.uniforms;
    uniforms.uScene.value = this.sceneTarget.texture;
    uniforms.uBloom.value = wantsBloom ? this.blurB.texture : BLACK.texture;
    uniforms.uRays.value = wantsRays ? this.rays.texture : BLACK.texture;
    uniforms.uBloomStrength.value = wantsBloom ? this.bloomStrength : 0;
    uniforms.uRayStrength.value = wantsRays ? this.rayStrength * rayVisibility : 0;
    uniforms.uRayColor.value.copy(sky.sunColor);
    uniforms.uExposure.value = this.exposure;
    uniforms.uVignette.value = this.vignette;
    uniforms.uSaturation.value = this.saturation;
    uniforms.uUnderwater.value = underwater;

    this.draw(renderer, this.compositeMaterial, null);
  }

  draw(renderer, material, target) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    // The quad covers every pixel and writes an opaque colour, so there is
    // nothing a clear could contribute except a full-screen write per pass.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    for (const target of [this.sceneTarget, this.bright, this.blurA, this.blurB, this.rays]) {
      target.dispose();
    }
    this.quad.geometry.dispose();
    this.brightMaterial.dispose();
    this.blurMaterial.dispose();
    this.rayMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}

/** A 1x1 black texture, so a disabled pass still has something to sample. */
const BLACK = {
  texture: (() => {
    const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    texture.needsUpdate = true;
    return texture;
  })(),
};

function makeTarget(width, height, type, depth) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  // Left as linear working space: the conversion to sRGB happens once, in the
  // composite, on the way to the canvas.
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
