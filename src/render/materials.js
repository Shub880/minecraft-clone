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

/**
 * Shared lighting, in one string so the three passes cannot drift apart.
 *
 * The tangent frame is rebuilt per pixel from screen-space derivatives rather
 * than read from a vertex attribute. Greedy meshing means one quad can cover a
 * hundred blocks with UVs running 0..100, and the mesher would have to emit and
 * the GPU carry a tangent per vertex to say the same thing this says in four
 * instructions — using data the rasteriser already has.
 */
/**
 * Sun shadowing, in its own chunk so the fast path never compiles it.
 *
 * Two things are layered here. The shadow map answers "can this pixel see the
 * sun", which gives trees and buildings shadows that move with the day. The
 * cloud field answers "is a cloud in the way", which is what makes an open
 * field breathe as cover drifts over it — the single cheapest effect on this
 * list and, over a wide landscape, one of the most convincing.
 */
const SHADOW_CHUNK = /* glsl */ `
  uniform sampler2D uShadowMap;
  uniform mat4 uShadowMatrix;
  uniform vec2 uShadowTexel;
  uniform float uShadowBias;
  uniform float uShadowNormalBias;
  uniform float uCloudShadow;

  float hashCloud(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  float cloudNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hashCloud(i);
    float b = hashCloud(i + vec2(1.0, 0.0));
    float c = hashCloud(i + vec2(0.0, 1.0));
    float d = hashCloud(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /** Drifting cover overhead, projected straight down onto the world. */
  float cloudShadow(vec3 worldPos) {
    if (uCloudShadow <= 0.001) return 1.0;
    vec2 p = worldPos.xz * 0.011 + vec2(uTime * 0.006, uTime * 0.003);
    float density = cloudNoise(p) * 0.62 + cloudNoise(p * 2.7) * 0.38;
    // Only the denser half of the field casts anything, so the ground is
    // mostly lit with occasional cover rather than permanently dappled.
    return 1.0 - smoothstep(0.52, 0.78, density) * uCloudShadow;
  }

  /**
   * 1 where the sun reaches, 0 in shadow.
   *
   * The sample point is pushed along the surface normal before projection
   * rather than only biased in depth. A depth bias alone has to be large
   * enough for the worst-case slope in the scene, and at that size it detaches
   * every shadow from the thing casting it; a normal offset scales with the
   * texel footprint instead and leaves contact shadows attached.
   */
  float sunShadow(vec3 worldPos, vec3 normal) {
    vec4 lightSpace = uShadowMatrix * vec4(worldPos + normal * uShadowNormalBias, 1.0);
    vec3 projected = lightSpace.xyz / lightSpace.w;
    if (projected.z > 1.0) return 1.0;

    float lit = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 offset = vec2(float(x), float(y)) * uShadowTexel;
        float depth = texture(uShadowMap, projected.xy + offset).r;
        lit += projected.z - uShadowBias <= depth ? 1.0 : 0.0;
      }
    }
    lit /= 9.0;

    // Dissolve at the edge of the covered box, so its boundary is never a
    // visible line drawn across the landscape.
    vec2 fromCentre = abs(projected.xy - 0.5) * 2.0;
    float edge = smoothstep(0.75, 1.0, max(fromCentre.x, fromCentre.y));
    return mix(lit, 1.0, edge);
  }
`;

const LIGHTING_CHUNK = /* glsl */ `
  uniform sampler2DArray uSurface;
  uniform float uSpecular;

  /** Tangent-space normal to world space, without a tangent attribute. */
  vec3 applyRelief(vec3 geometryNormal, vec3 tangentNormal) {
    vec3 dpx = dFdx(vWorldPos);
    vec3 dpy = dFdy(vWorldPos);
    vec2 duvx = dFdx(vUv);
    vec2 duvy = dFdy(vUv);

    vec3 t = dpx * duvy.y - dpy * duvx.y;
    vec3 b = -dpx * duvy.x + dpy * duvx.x;
    float scale = inversesqrt(max(dot(t, t), dot(b, b)));
    if (!(scale < 3.4e38)) return geometryNormal;

    mat3 frame = mat3(t * scale, b * scale, geometryNormal);
    return normalize(frame * tangentNormal);
  }

  /**
   * Blinn-Phong, with the exponent driven by the surface's roughness.
   *
   * Gated on skylight rather than applied everywhere: a sun highlight inside a
   * cave gives away that this is a light model rather than a light.
   */
  float sunSpecular(vec3 normal, vec3 viewDir, float roughness, float sky) {
    if (sky <= 0.001) return 0.0;
    float shininess = mix(180.0, 3.0, roughness * roughness);
    vec3 halfway = normalize(uSunDirection - viewDir);
    float spec = pow(max(dot(normal, halfway), 0.0), shininess);
    // Normalisation, so a tight highlight is bright and a broad one is not
    // simply the same energy smeared out.
    return spec * (shininess + 8.0) / 40.0 * (1.0 - roughness) * sky;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uAtlas;
  // Shared with the vertex stage: the water highlight has to be computed from
  // the same clock that displaced the surface, or it slides off the waves.
  uniform float uTime;
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

  #ifdef FANCY
    ${LIGHTING_CHUNK}
  #endif

  #ifdef SHADOWS
    ${SHADOW_CHUNK}
  #endif

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
    vec3 geometryNormal = FACE_NORMALS[face];
    vec3 normal = geometryNormal;
    float facet = FACE_SHADE[face];

    // Light levels are perceptually non-linear; squaring keeps caves genuinely
    // dark without crushing the mid range outdoors.
    float sky = vSky * uDaylight;
    sky = sky * sky * 0.75 + sky * 0.25;
    float torch = vBlock * vBlock * 0.8 + vBlock * 0.2;

    float roughness = 1.0;
    float emissive = 0.0;
    vec3 viewDir = normalize(vWorldPos - cameraPosition);

    #ifdef FANCY
      vec4 surface = texture(uSurface, vec3(vUv, vLayer));
      roughness = surface.b;
      emissive = surface.a;
      vec2 relief = surface.rg * 2.0 - 1.0;
      vec3 tangentNormal = normalize(vec3(relief, sqrt(max(1.0 - dot(relief, relief), 0.0))));
      // Plants are flat cards standing in for volume; bending their normals
      // only makes the illusion worse.
      if (face != 6) normal = applyRelief(geometryNormal, tangentNormal);
    #endif

    float sunDot = max(dot(normal, uSunDirection), 0.0);
    float direct = 0.6 + 0.4 * sunDot;

    // 1 in full sun, 0 in shadow. Plants are flat cards whose normals point at
    // the camera, so they are offset along the geometric up instead.
    float sunlit = 1.0;
    #ifdef SHADOWS
      vec3 offsetNormal = face == 6 ? vec3(0.0, 1.0, 0.0) : geometryNormal;
      sunlit = sunShadow(vWorldPos, offsetNormal) * cloudShadow(vWorldPos);
    #endif

    // Shadowed ground keeps the sky's ambient and loses the sun, so it goes
    // blue and cool rather than simply dark — which is what shadow actually
    // looks like outdoors, and what a flat multiply gets wrong.
    vec3 skyLight = mix(uAmbientColor, uSunColor, direct * 0.65 * mix(0.2, 1.0, sunlit)) * sky;
    skyLight *= mix(0.6, 1.0, sunlit);

    vec3 lighting = uAmbientColor * 0.06
                  + skyLight * facet
                  + TORCH_COLOR * torch;
    lighting *= vAO * uBrightness;

    vec3 color = albedo * lighting;

    #ifdef FANCY
      // Specular is added, not mixed: a highlight is light arriving on top of
      // what the surface already reflects, and mixing would darken the albedo
      // wherever the sun happens to catch it.
      color += uSunColor * sunSpecular(normal, viewDir, roughness, sky)
             * uSpecular * vAO * facet * sunlit;
      // Emissive ignores sky and block light — that is the whole point of it —
      // but still respects brightness so the setting stays meaningful.
      color += albedo * emissive * 2.6 * uBrightness;
    #endif

    float alpha = 1.0;

    #ifdef WATER
      #ifdef FANCY
        // The wave normal is the analytic derivative of the displacement the
        // vertex stage applied, so the highlight tracks the crests it is
        // supposed to be sitting on instead of drifting across them. Only the
        // top face is displaced, so only the top face is re-normalled.
        if (face == 2) {
          float slopeX =
            cos(vWorldPos.x * 0.55 + uTime * 1.1) * 0.55 * 0.5 +
            cos((vWorldPos.x + vWorldPos.z) * 0.27 + uTime * 1.6) * 0.27 * 0.35;
          float slopeZ =
            cos(vWorldPos.z * 0.42 - uTime * 0.83) * 0.42 * 0.5 +
            cos((vWorldPos.x + vWorldPos.z) * 0.27 + uTime * 1.6) * 0.27 * 0.35;
          normal = normalize(vec3(-slopeX * 0.045 * 8.0, 1.0, -slopeZ * 0.045 * 8.0));
        }
        float glint = sunSpecular(normal, viewDir, 0.04, sky);
        color += uSunColor * glint * uSpecular * 1.6 * (1.0 - uUnderwater) * sunlit;
      #endif
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
    float horizon = clamp(viewDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 fogColor = mix(uFogHorizon, uFogZenith, horizon * horizon);

    // Forward scattering: air lit from behind glows toward the light. Looking
    // into the sun the haze warms and brightens, away from it it stays cool.
    // This is what makes distance read as air rather than as a grey wash.
    // A tight exponent matters: spread wide it stops being a glow around the
    // sun and becomes a milky wash over the whole distance.
    float towardSun = max(dot(viewDir, uSunDirection), 0.0);
    fogColor = mix(fogColor, uSunColor, pow(towardSun, 9.0) * 0.32 * uDaylight);

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
  /**
   * @param {THREE.DataArrayTexture} atlasTexture   colour
   * @param {THREE.DataArrayTexture} [surfaceTexture]  normal, roughness, emissive
   */
  constructor(atlasTexture, surfaceTexture = null) {
    this.fancy = true;
    this.shadows = false;
    this.uniforms = {
      uAtlas: { value: atlasTexture },
      uSurface: { value: surfaceTexture },
      uSpecular: { value: 1 },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      // Small enough that contact shadows stay attached, large enough that a
      // lit floor does not stripe itself. Retuned whenever quality changes.
      uShadowBias: { value: 0.0006 },
      uShadowNormalBias: { value: 0.09 },
      uCloudShadow: { value: 0.55 },
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
    if (this.fancy) defines.FANCY = '';
    if (this.shadows) defines.SHADOWS = '';

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

  /**
   * Turn the per-pixel lighting on or off.
   *
   * The relief, the sun highlight and the emissive pass all live behind one
   * define, so switching quality recompiles three shaders and changes nothing
   * else — the materials themselves are the same objects, and every chunk mesh
   * already pointing at them stays valid.
   */
  setFancy(enabled) {
    const next = Boolean(enabled);
    if (next === this.fancy) return;
    this.fancy = next;
    for (const material of [this.opaque, this.cutout, this.water]) {
      if (next) material.defines.FANCY = '';
      else delete material.defines.FANCY;
      material.needsUpdate = true;
    }
  }

  /**
   * Turn cast shadows on or off.
   *
   * Like `setFancy`, this is a define rather than a branch: a shadow lookup
   * costs nine texture fetches per pixel and there is no point paying for a
   * disabled one. The chunk meshes point at the same material objects
   * throughout, so nothing downstream has to be rebuilt.
   */
  setShadows(enabled) {
    const next = Boolean(enabled);
    if (next === this.shadows) return;
    this.shadows = next;
    for (const material of [this.opaque, this.cutout, this.water]) {
      if (next) material.defines.SHADOWS = '';
      else delete material.defines.SHADOWS;
      material.needsUpdate = true;
    }
  }

  /** Point the shader at a freshly rendered shadow map. */
  applyShadowMap(shadows) {
    if (!shadows) return;
    this.uniforms.uShadowMap.value = shadows.depthTexture;
    this.uniforms.uShadowMatrix.value.copy(shadows.matrix);
    this.uniforms.uShadowTexel.value.copy(shadows.texel);
    // Depth precision is spread over the whole light frustum, so a wider box
    // needs a proportionally larger bias to stay free of acne.
    this.uniforms.uShadowBias.value = 0.00035 + shadows.radius * 0.000012;
    this.uniforms.uShadowNormalBias.value = shadows.worldTexel * 1.4;
  }

  /** How much drifting cloud cover dims the ground, 0..1. */
  setCloudShadow(amount) {
    this.uniforms.uCloudShadow.value = Math.max(0, Math.min(1, amount));
  }

  /** Strength of the sun highlight, 0 to switch it off without losing relief. */
  setSpecular(strength) {
    this.uniforms.uSpecular.value = Number.isFinite(strength) ? strength : 1;
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
    // Just enough to dissolve the loaded edge. Denser than this and the middle
    // distance goes flat, which the sun scattering then amplifies.
    this.uniforms.uFogDensity.value = 1.32 / blocks;
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
