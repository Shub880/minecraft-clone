/**
 * Chunk materials.
 *
 * Three passes share one vertex/fragment source, specialised with defines:
 *
 *   opaque       solid blocks. Texture alpha is a *tint mask*.
 *   cutout       leaves, plants, glass. Texture alpha is the cutout mask,
 *                drawn double sided so plant quads are visible from behind.
 *   water        the transparent pass, with wave displacement and fresnel.
 *
 * All uniforms are shared by reference, so the frame loop updates the sun,
 * fog and time once and every pass picks it up.
 *
 * Colour space: every colour uniform here is *linear*. The only conversion in
 * the shader is on the texture sample, which is authored in sRGB.
 */

import * as THREE from 'three';

const VERTEX_SHADER = /* glsl */ `
  attribute float layer;
  // Raw 0..255 values: [ambient occlusion, skylight, blocklight, face index].
  attribute vec4 shade;
  // Raw 0..255 values: [tint r, tint g, tint b, wind sway weight].
  attribute vec4 tint;

  uniform float uTime;
  uniform float uWindStrength;

  varying vec2 vUv;
  varying float vLayer;
  varying vec3 vTint;
  varying float vAO;
  varying float vSky;
  varying float vBlock;
  varying float vFace;
  varying vec3 vWorldPos;
  varying float vViewDepth;

  void main() {
    vUv = uv;
    vLayer = layer;
    vAO = shade.x / 255.0;
    vSky = shade.y / 255.0;
    vBlock = shade.z / 255.0;
    vFace = shade.w;
    vTint = tint.rgb / 255.0;

    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    // Wind. The sway weight is baked per vertex by the mesher, so a plant's
    // roots stay planted while its tip moves, with no shader-side anchoring.
    float sway = tint.a / 255.0;
    if (sway > 0.0) {
      float gust =
        sin(worldPos.x * 0.5 + worldPos.z * 0.35 + uTime * 1.4) * 0.6 +
        sin(worldPos.x * 0.17 - worldPos.z * 0.23 + uTime * 0.73) * 0.4;
      float amp = sway * uWindStrength;
      worldPos.x += gust * amp;
      worldPos.z += gust * amp * 0.6;
      // Bending shortens the plant slightly, which reads as weight.
      worldPos.y -= abs(gust) * amp * 0.22;
    }

    #ifdef WATER
      // Three crossing wave trains, so the surface never visibly repeats.
      float wave =
        sin(worldPos.x * 0.55 + uTime * 1.1) * 0.5 +
        sin(worldPos.z * 0.42 - uTime * 0.83) * 0.5 +
        sin((worldPos.x + worldPos.z) * 0.27 + uTime * 1.6) * 0.35;
      // Only the top surface moves; side faces stay flush with the shore.
      float isTop = step(1.5, vFace) * step(vFace, 2.5);
      worldPos.y += wave * 0.045 * isTop;
    #endif

    vWorldPos = worldPos.xyz;
    vec4 mvPosition = viewMatrix * worldPos;
    vViewDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uAtlas;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform float uDaylight;
  uniform vec3 uFogHorizon;
  uniform vec3 uFogZenith;
  uniform float uFogDensity;
  uniform float uUnderwater;
  uniform vec3 uUnderwaterColor;
  uniform float uBrightness;
  uniform float uWaterOpacity;

  varying vec2 vUv;
  varying float vLayer;
  varying vec3 vTint;
  varying float vAO;
  varying float vSky;
  varying float vBlock;
  varying float vFace;
  varying vec3 vWorldPos;
  varying float vViewDepth;

  // Index 6 is the "flat" face used by plants: no directional shading.
  const vec3 FACE_NORMALS[7] = vec3[7](
    vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
    vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
    vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0),
    vec3( 0.0, 1.0, 0.0)
  );

  // Facet shading. Gentler than the classic voxel ramp because real ambient
  // occlusion is already doing most of the shape-reading work.
  const float FACE_SHADE[7] = float[7](0.86, 0.86, 1.0, 0.58, 0.76, 0.76, 0.97);

  const vec3 TORCH_COLOR = vec3(1.0, 0.64, 0.32);

  vec3 toLinear(vec3 c) {
    return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
  }

  void main() {
    vec4 texel = texture(uAtlas, vec3(vUv, vLayer));

    #ifdef CUTOUT
      if (texel.a < 0.5) discard;
      vec3 albedo = toLinear(texel.rgb) * vTint;
    #elif defined(WATER)
      vec3 albedo = toLinear(texel.rgb) * vTint;
    #else
      // Alpha is a tint mask on opaque textures: 0 tints, 1 leaves alone.
      // This is what lets a grass block's side face tint only its green fringe
      // while the dirt below it stays brown.
      vec3 albedo = toLinear(texel.rgb) * mix(vTint, vec3(1.0), texel.a);
    #endif

    int face = int(vFace + 0.5);
    vec3 normal = FACE_NORMALS[face];
    float facet = FACE_SHADE[face];

    // Light levels are perceptually non-linear; squaring keeps caves genuinely
    // dark without crushing the mid range outdoors.
    float sky = vSky * uDaylight;
    sky = sky * sky * 0.75 + sky * 0.25;
    float torch = vBlock * vBlock * 0.8 + vBlock * 0.2;

    float sunDot = max(dot(normal, uSunDirection), 0.0);
    float direct = 0.6 + 0.4 * sunDot;

    vec3 skyLight = mix(uAmbientColor, uSunColor, direct * 0.65) * sky;
    vec3 lighting = uAmbientColor * 0.06
                  + skyLight * facet
                  + TORCH_COLOR * torch;
    lighting *= vAO * uBrightness;

    vec3 color = albedo * lighting;
    float alpha = 1.0;

    #ifdef WATER
      vec3 viewDir = normalize(vWorldPos - cameraPosition);
      // Fresnel: water turns reflective and bright at grazing angles, which is
      // what makes a lake read as a surface rather than a blue floor.
      float fresnel = pow(1.0 - abs(dot(viewDir, normal)), 3.0);
      color = mix(color, uFogHorizon * (0.35 + 0.65 * uDaylight), fresnel * 0.6);
      alpha = mix(uWaterOpacity, 1.0, fresnel * 0.5);
      // Fully opaque when the camera is submerged, so the surface reads as a
      // ceiling from below instead of vanishing.
      alpha = mix(alpha, 0.72, uUnderwater);
    #endif

    // Height-graded fog matched to the sky gradient, so the horizon dissolves
    // instead of terminating in a visible wall of flat colour.
    vec3 viewRay = normalize(vWorldPos - cameraPosition);
    float horizon = clamp(viewRay.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 fogColor = mix(uFogHorizon, uFogZenith, horizon * horizon);

    float d = vViewDepth * uFogDensity;
    float fogFactor = 1.0 - exp(-d * d);

    // Underwater swaps to a dense, close blue.
    fogColor = mix(fogColor, uUnderwaterColor, uUnderwater);
    float underwaterFog = 1.0 - exp(-vViewDepth * 0.06);
    fogFactor = mix(fogFactor, underwaterFog, uUnderwater);

    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Owns the shared uniform block and the three chunk materials.
 * Update the uniforms once per frame via the setters at the bottom.
 */
export class WorldMaterials {
  constructor(atlasTexture) {
    this.uniforms = {
      uAtlas: { value: atlasTexture },
      uTime: { value: 0 },
      uWindStrength: { value: 0.06 },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Vector3(1.0, 0.96, 0.86) },
      uAmbientColor: { value: new THREE.Vector3(0.44, 0.52, 0.66) },
      uDaylight: { value: 1 },
      uFogHorizon: { value: new THREE.Vector3(0.62, 0.74, 0.92) },
      uFogZenith: { value: new THREE.Vector3(0.32, 0.52, 0.86) },
      uFogDensity: { value: 0.0055 },
      uUnderwater: { value: 0 },
      uUnderwaterColor: { value: new THREE.Vector3(0.05, 0.18, 0.34) },
      uBrightness: { value: 1 },
      uWaterOpacity: { value: 0.78 },
    };

    this.opaque = this.createMaterial('opaque');
    this.cutout = this.createMaterial('cutout');
    this.water = this.createMaterial('water');
  }

  createMaterial(mode) {
    const defines = {};
    if (mode === 'cutout') defines.CUTOUT = '';
    if (mode === 'water') defines.WATER = '';

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: mode === 'cutout' ? THREE.DoubleSide : THREE.FrontSide,
      transparent: mode === 'water',
      // Water still writes depth: it self-culls, so only one surface exists at
      // a time and depth writing keeps terrain behind it correctly hidden.
      depthWrite: true,
      alphaTest: 0,
    });
    material.name = `chunk-${mode}`;
    return material;
  }

  /** Advance animated effects. `time` is in seconds. */
  setTime(time) {
    this.uniforms.uTime.value = time;
  }

  setWind(strength) {
    this.uniforms.uWindStrength.value = strength;
  }

  /** Push the current sky state into the shared uniforms. */
  applySky(sky) {
    this.uniforms.uSunDirection.value.copy(sky.sunDirection);
    this.uniforms.uSunColor.value.copy(sky.sunColor);
    this.uniforms.uAmbientColor.value.copy(sky.ambientColor);
    this.uniforms.uDaylight.value = sky.daylight;
    this.uniforms.uFogHorizon.value.copy(sky.horizonColor);
    this.uniforms.uFogZenith.value.copy(sky.zenithColor);
  }

  /** Fog density is derived from render distance so the far plane is hidden. */
  setRenderDistance(chunks) {
    const blocks = chunks * 16;
    this.uniforms.uFogDensity.value = 1.6 / blocks;
  }

  setUnderwater(amount) {
    this.uniforms.uUnderwater.value = amount;
  }

  setBrightness(value) {
    this.uniforms.uBrightness.value = value;
  }

  dispose() {
    this.opaque.dispose();
    this.cutout.dispose();
    this.water.dispose();
  }
}

/**
 * Build a Three geometry from one mesher output bucket.
 * Attributes are non-normalised bytes where the shader needs exact integers
 * (the face index lives in `shade.w`), so everything is divided by 255 in GLSL
 * rather than relying on normalisation.
 */
export function buildGeometry(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setAttribute('layer', new THREE.BufferAttribute(data.layers, 1));
  geometry.setAttribute('shade', new THREE.BufferAttribute(data.shade, 4, false));
  geometry.setAttribute('tint', new THREE.BufferAttribute(data.tint, 4, false));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return geometry;
}
