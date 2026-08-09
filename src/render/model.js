/**
 * Box models drawn from the block atlas.
 *
 * The held-item view model and the third-person avatar are both stacks of
 * textured boxes, and both sample the same `DataArrayTexture` the world uses.
 * Sharing the atlas means neither costs an extra texture bind, and a model
 * showing a block looks exactly like the block it represents.
 *
 * These models are lit by a simplified version of the world's lighting: a sun
 * term, an ambient term and a single block-light level supplied by the caller,
 * with no per-vertex light sampling. They are small and always near the camera,
 * so the cheap approximation is invisible.
 */

import * as THREE from 'three';

/** Face order matches the block registry: +X, -X, +Y, -Y, +Z, -Z. */
const FACES = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] },
];

/** Same facet ramp the world shader uses, so models sit in the same light. */
const FACE_SHADE = [0.86, 0.86, 1.0, 0.58, 0.76, 0.76];

const VERTEX_SHADER = /* glsl */ `
  attribute float layer;
  attribute float faceShade;

  varying vec2 vUv;
  varying float vLayer;
  varying float vShade;
  varying vec3 vNormal;

  #ifdef VERTEX_TINT
    // Mobs are drawn as one merged mesh, so their colour — a sheep's fleece,
    // a hurt animal's red flash — has to ride on the vertices rather than on
    // a uniform that could only describe one animal at a time.
    attribute vec3 aTint;
    // x is skylight, y is block light, both already 0..1.
    attribute vec2 aLight;
    varying vec3 vVertexTint;
    varying vec2 vVertexLight;
  #endif

  void main() {
    vUv = uv;
    vLayer = layer;
    vShade = faceShade;
    vNormal = normalize(mat3(modelMatrix) * normal);
    #ifdef VERTEX_TINT
      vVertexTint = aTint;
      vVertexLight = aLight;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
  uniform vec3 uTint;
  uniform float uBlockLight;
  uniform float uBrightness;

  varying vec2 vUv;
  varying float vLayer;
  varying float vShade;
  varying vec3 vNormal;

  #ifdef VERTEX_TINT
    varying vec3 vVertexTint;
    varying vec2 vVertexLight;
  #endif

  const vec3 TORCH_COLOR = vec3(1.0, 0.64, 0.32);

  vec3 toLinear(vec3 c) {
    return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
  }

  void main() {
    vec4 texel = texture(uAtlas, vec3(vUv, vLayer));

    #ifdef VERTEX_TINT
      vec3 tint = vVertexTint;
      float skyLevel = vVertexLight.x;
      float torchLevel = vVertexLight.y;
    #else
      vec3 tint = uTint;
      float skyLevel = 1.0;
      float torchLevel = uBlockLight;
    #endif

    #ifdef CUTOUT
      // Plants and torches: alpha really is a cutout mask.
      if (texel.a < 0.5) discard;
      vec3 albedo = toLinear(texel.rgb) * tint;
    #else
      // Everything else: alpha is a *tint mask*, exactly as in the world
      // shader. Discarding on it would erase a grass block's entire top face,
      // which is painted greyscale with alpha 0 so the biome tint can colour it.
      vec3 albedo = toLinear(texel.rgb) * mix(tint, vec3(1.0), texel.a);
    #endif

    float sun = max(dot(vNormal, uSunDirection), 0.0);
    // skyLevel is how much of the sky reaches this model: 1 for the held item
    // and the avatar, which are always beside the camera, and the sampled
    // skylight for a mob, which may well be standing in a cave.
    vec3 light = uAmbientColor * (0.28 + 0.35 * uDaylight * skyLevel)
               + uSunColor * uDaylight * skyLevel * (0.35 + 0.5 * sun)
               + TORCH_COLOR * torchLevel;

    gl_FragColor = vec4(albedo * light * vShade * uBrightness, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * A material for atlas-textured box models. Uniforms are per-material rather
 * than shared, because the view model and the avatar want different tints and
 * different block-light levels.
 *
 * @param {THREE.DataArrayTexture} atlasTexture
 * @param {{cutout?: boolean, vertexTint?: boolean}} [options]  `cutout` treats
 *   alpha as a cutout mask rather than a tint mask — correct for plants, wrong
 *   for everything else. `vertexTint` reads the colour and skylight from
 *   per-vertex attributes instead of uniforms, which is what lets many mobs
 *   share one mesh.
 */
export function createModelMaterial(atlasTexture, { cutout = false, vertexTint = false } = {}) {
  const defines = {};
  if (cutout) defines.CUTOUT = '';
  if (vertexTint) defines.VERTEX_TINT = '';

  const material = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uAtlas: { value: atlasTexture },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Vector3(1, 0.97, 0.9) },
      uAmbientColor: { value: new THREE.Vector3(0.42, 0.5, 0.64) },
      uDaylight: { value: 1 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uBlockLight: { value: 0 },
      uBrightness: { value: 1 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  material.name = 'model';
  return material;
}

/** Push the current sky into a model material so it matches the world. */
export function applySkyToModel(material, sky, brightness = 1) {
  const u = material.uniforms;
  u.uSunDirection.value.copy(sky.sunDirection);
  u.uSunColor.value.copy(sky.sunColor);
  u.uAmbientColor.value.copy(sky.ambientColor);
  u.uDaylight.value = sky.daylight;
  u.uBrightness.value = brightness;
}

/**
 * Build a box centred on the origin in X and Z and rising from y = 0.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} depth
 * @param {number[]} layers  six atlas layer indices, in face order
 */
export function buildBoxGeometry(width, height, depth, layers) {
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const layerAttribute = new Float32Array(24);
  const shade = new Float32Array(24);
  const indices = new Uint16Array(36);

  const size = [width, height, depth];
  const origin = [-width / 2, 0, -depth / 2];

  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const base = f * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      for (let axis = 0; axis < 3; axis++) {
        positions[v * 3 + axis] = origin[axis] + face.corners[c][axis] * size[axis];
        normals[v * 3 + axis] = face.normal[axis];
      }
      uvs[v * 2] = face.uv[c][0];
      uvs[v * 2 + 1] = face.uv[c][1];
      layerAttribute[v] = layers[f] ?? layers[0] ?? 0;
      shade[v] = FACE_SHADE[f];
    }
    // Wound so the triangles face outward. With the corner order above, the
    // natural 0-1-2 / 0-2-3 fan points *inward*, which back-face culling then
    // removes — leaving a model you can only see the inside of.
    const i = f * 6;
    indices[i] = base; indices[i + 1] = base + 2; indices[i + 2] = base + 1;
    indices[i + 3] = base; indices[i + 4] = base + 3; indices[i + 5] = base + 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('layer', new THREE.BufferAttribute(layerAttribute, 1));
  geometry.setAttribute('faceShade', new THREE.BufferAttribute(shade, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

/**
 * Rewrite an existing box geometry's layers in place. Swapping the held block
 * every time the player scrolls the hotbar would otherwise churn geometry.
 */
export function setBoxLayers(geometry, layers) {
  const attribute = geometry.attributes.layer;
  for (let f = 0; f < 6; f++) {
    const value = layers[f] ?? layers[0] ?? 0;
    for (let c = 0; c < 4; c++) attribute.array[f * 4 + c] = value;
  }
  attribute.needsUpdate = true;
}

/**
 * A flat two-quad cross, matching how the world draws plants and torches, so a
 * held flower is a flower rather than a cube with a flower painted on it.
 */
export function buildCrossGeometry(layer, scale = 1) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const layers = [];
  const shade = [];
  const indices = [];

  const half = 0.5 * scale;
  const quads = [
    { a: [-half, 0, -half], b: [half, 0, half], normal: [-0.707, 0, 0.707] },
    { a: [half, 0, -half], b: [-half, 0, half], normal: [0.707, 0, 0.707] },
  ];

  quads.forEach((quad, q) => {
    const base = q * 4;
    const corners = [
      [quad.a[0], 0, quad.a[2]],
      [quad.b[0], 0, quad.b[2]],
      [quad.b[0], scale, quad.b[2]],
      [quad.a[0], scale, quad.a[2]],
    ];
    const uvSet = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let c = 0; c < 4; c++) {
      positions.push(...corners[c]);
      normals.push(...quad.normal);
      uvs.push(...uvSet[c]);
      layers.push(layer);
      shade.push(0.97);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('layer', new THREE.Float32BufferAttribute(layers, 1));
  geometry.setAttribute('faceShade', new THREE.Float32BufferAttribute(shade, 1));
  geometry.setIndex(indices);
  return geometry;
}
