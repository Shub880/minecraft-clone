/**
 * Sky dome, day/night cycle, and the lighting colours the whole world reads.
 *
 * This module is the single source of truth for time of day. The chunk
 * materials, fog and (later) post-processing all pull their colours from here,
 * so the scene stays coherent through sunrise and sunset instead of the sky
 * and the ground disagreeing about what time it is.
 *
 * Every colour is linear.
 */

import * as THREE from 'three';

/** Real seconds for one full day/night cycle. */
export const DAY_LENGTH = 1200;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    // The dome follows the camera, so it never clips and needs no far plane.
    vDirection = position;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // Force onto the far plane so the sky always loses the depth test.
    gl_Position.z = gl_Position.w;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform vec3 uMoonColor;
  uniform float uStarOpacity;
  uniform float uTime;
  uniform float uCloudCoverage;
  uniform vec3 uCloudColor;
  uniform float uDaylight;

  varying vec3 vDirection;

  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += valueNoise(p) * amplitude;
      p *= 2.03;
      amplitude *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 dir = normalize(vDirection);
    float height = dir.y;

    // Base gradient. The exponent keeps most of the colour change close to the
    // horizon, where the eye actually looks.
    float t = pow(clamp(height, 0.0, 1.0), 0.42);
    vec3 color = mix(uHorizon, uZenith, t);

    // Below the horizon, fade to a slightly darker ground haze.
    color = mix(color, uHorizon * 0.72, smoothstep(0.0, -0.22, height));

    float sunAmount = max(dot(dir, uSunDirection), 0.0);

    // Stars, drawn before the sun so the sun washes them out.
    if (uStarOpacity > 0.001) {
      vec2 starUv = dir.xz / max(abs(dir.y) + 0.35, 0.001) * 3.4;
      vec2 cell = floor(starUv * 60.0);
      float rnd = hash21(cell);
      if (rnd > 0.982) {
        vec2 local = fract(starUv * 60.0) - 0.5;
        float d = length(local);
        float brightness = smoothstep(0.34, 0.0, d) * (rnd - 0.982) / 0.018;
        // Slow twinkle, offset per star so they are not in lockstep.
        float twinkle = 0.72 + 0.28 * sin(uTime * 1.7 + rnd * 90.0);
        color += vec3(0.9, 0.94, 1.0) * brightness * twinkle
               * uStarOpacity * smoothstep(-0.05, 0.15, height);
      }
    }

    // Broad atmospheric glow around the sun, strongest at low angles. This is
    // what paints the warm band across the horizon at sunrise and sunset.
    color += uSunColor * pow(sunAmount, 6.0) * 0.35;
    color += uSunColor * pow(sunAmount, 128.0) * 1.6;

    // Sun disc.
    float sunDisc = smoothstep(0.99965, 0.99985, sunAmount);
    color = mix(color, uSunColor * 5.5, sunDisc);

    // Moon, opposite the sun.
    float moonAmount = max(dot(dir, -uSunDirection), 0.0);
    float moonDisc = smoothstep(0.99955, 0.99978, moonAmount);
    color = mix(color, uMoonColor * 2.4, moonDisc * uStarOpacity);
    color += uMoonColor * pow(moonAmount, 220.0) * 0.5 * uStarOpacity;

    // Clouds on a virtual plane. Dividing by dir.y projects the ray onto an
    // infinite plane, so clouds converge at the horizon without any geometry.
    if (height > 0.015) {
      vec2 cloudUv = dir.xz / height * 0.55;
      cloudUv += vec2(uTime * 0.0045, uTime * 0.0022);
      float density = fbm(cloudUv * 0.9);
      // A second, slower layer adds depth without a second draw.
      density = density * 0.75 + fbm(cloudUv * 0.35 - uTime * 0.001) * 0.25;

      float coverage = smoothstep(uCloudCoverage, uCloudCoverage + 0.18, density);
      // Fade clouds out at the horizon so the plane's edge never shows.
      coverage *= smoothstep(0.015, 0.16, height);

      // Shade the underside using the density gradient, so clouds have volume.
      float shading = smoothstep(uCloudCoverage - 0.06, uCloudCoverage + 0.26, density);
      vec3 cloud = mix(uCloudColor * 0.52, uCloudColor, shading);

      // Silver lining. Light that has made it through the thin edge of a cloud
      // comes out the far side, so the rim facing the sun glows and the deep
      // middle stays grey. Sampling the field again a short step toward the sun
      // is a cheap stand-in for measuring how much cloud the ray crossed.
      vec2 towardSun = normalize(uSunDirection.xz + vec2(1e-4)) * 0.16;
      float behind = fbm((cloudUv + towardSun) * 0.9);
      float thinness = clamp((density - behind) * 3.4, 0.0, 1.0);
      float sunFacing = pow(max(dot(dir, uSunDirection), 0.0), 3.0);
      cloud += uSunColor * thinness * (0.35 + 0.9 * sunFacing) * uDaylight;

      cloud = mix(cloud, cloud * (0.5 + 0.5 * uDaylight), 1.0 - uDaylight);
      color = mix(color, cloud, coverage * 0.92);
    }

    gl_FragColor = vec4(color, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Palette, all linear. Tuned so noon reads clean and neutral while sunrise and
// sunset get genuinely warm without turning the whole world orange.
const DAY_ZENITH = new THREE.Vector3(0.13, 0.32, 0.78);
const DAY_HORIZON = new THREE.Vector3(0.58, 0.76, 0.96);
const NIGHT_ZENITH = new THREE.Vector3(0.006, 0.010, 0.032);
const NIGHT_HORIZON = new THREE.Vector3(0.022, 0.036, 0.082);
const SUNSET_HORIZON = new THREE.Vector3(0.96, 0.40, 0.16);
const SUNSET_ZENITH = new THREE.Vector3(0.22, 0.20, 0.50);

const DAY_SUN = new THREE.Vector3(1.0, 0.97, 0.90);
const SUNSET_SUN = new THREE.Vector3(1.0, 0.52, 0.22);
const MOON_COLOR = new THREE.Vector3(0.62, 0.70, 0.92);

const DAY_AMBIENT = new THREE.Vector3(0.42, 0.50, 0.64);
const NIGHT_AMBIENT = new THREE.Vector3(0.05, 0.07, 0.14);

const DAY_CLOUD = new THREE.Vector3(1.0, 0.99, 0.98);
const SUNSET_CLOUD = new THREE.Vector3(1.0, 0.66, 0.48);
const NIGHT_CLOUD = new THREE.Vector3(0.10, 0.12, 0.20);

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mixVec(out, a, b, t) {
  out.set(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t,
  );
  return out;
}

export class Sky {
  constructor(scene) {
    this.scene = scene;

    /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
    this.timeOfDay = 0.32;
    this.frozen = false;

    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Vector3().copy(DAY_SUN);
    this.ambientColor = new THREE.Vector3().copy(DAY_AMBIENT);
    this.horizonColor = new THREE.Vector3().copy(DAY_HORIZON);
    this.zenithColor = new THREE.Vector3().copy(DAY_ZENITH);
    this.daylight = 1;

    this.uniforms = {
      uZenith: { value: this.zenithColor },
      uHorizon: { value: this.horizonColor },
      uSunColor: { value: this.sunColor },
      uSunDirection: { value: this.sunDirection },
      uMoonColor: { value: new THREE.Vector3().copy(MOON_COLOR) },
      uStarOpacity: { value: 0 },
      uTime: { value: 0 },
      uCloudCoverage: { value: 0.5 },
      uCloudColor: { value: new THREE.Vector3().copy(DAY_CLOUD) },
      uDaylight: { value: 1 },
    };

    const geometry = new THREE.SphereGeometry(1, 32, 16);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    material.name = 'sky';

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    // Drawn first, with depth writes off, so everything else covers it.
    this.mesh.renderOrder = -1000;
    this.scene.add(this.mesh);

    this.update(0);
  }

  /** Set time directly, 0..1. */
  setTime(fraction) {
    this.timeOfDay = ((fraction % 1) + 1) % 1;
  }

  /** Advance the cycle and recompute every derived colour. */
  update(deltaSeconds, elapsed = 0) {
    if (!this.frozen) {
      this.timeOfDay = (this.timeOfDay + deltaSeconds / DAY_LENGTH) % 1;
    }

    const angle = (this.timeOfDay - 0.25) * Math.PI * 2;
    this.sunDirection.set(Math.cos(angle), Math.sin(angle), 0.32).normalize();

    const elevation = this.sunDirection.y;
    const day = smoothstep(-0.08, 0.24, elevation);
    // Gaussian centred on the horizon: the golden hour.
    const sunset = Math.exp(-(elevation * elevation) / (2 * 0.11 * 0.11));
    const night = 1 - day;

    mixVec(this.zenithColor, NIGHT_ZENITH, DAY_ZENITH, day);
    mixVec(this.horizonColor, NIGHT_HORIZON, DAY_HORIZON, day);

    // Layer the warm band on top of the day/night blend rather than replacing
    // it, so the transition stays smooth in both directions.
    const warmth = sunset * (0.35 + 0.65 * day);
    mixVec(this.horizonColor, this.horizonColor, SUNSET_HORIZON, warmth * 0.85);
    mixVec(this.zenithColor, this.zenithColor, SUNSET_ZENITH, warmth * 0.4);

    mixVec(this.sunColor, MOON_COLOR, DAY_SUN, day);
    mixVec(this.sunColor, this.sunColor, SUNSET_SUN, warmth * 0.8);

    mixVec(this.ambientColor, NIGHT_AMBIENT, DAY_AMBIENT, day);

    // Skylight never drops to zero: moonlight keeps the surface readable.
    this.daylight = 0.09 + 0.91 * day;

    const cloudColor = this.uniforms.uCloudColor.value;
    mixVec(cloudColor, NIGHT_CLOUD, DAY_CLOUD, day);
    mixVec(cloudColor, cloudColor, SUNSET_CLOUD, warmth * 0.7);

    this.uniforms.uStarOpacity.value = night * night;
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uDaylight.value = day;
  }

  /** Keep the dome centred on the camera. */
  follow(camera) {
    this.mesh.position.copy(camera.position);
    // Scale below the far plane; depth test is off so size only affects nothing
    // but keeps the geometry in a sane numeric range.
    this.mesh.scale.setScalar(1);
  }

  setCloudCoverage(value) {
    this.uniforms.uCloudCoverage.value = value;
  }

  /** Human-readable clock, for the debug overlay and the pause screen. */
  getClock() {
    const totalMinutes = Math.floor(this.timeOfDay * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
