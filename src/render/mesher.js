/**
 * Section mesher: greedy meshing with per-vertex ambient occlusion and smooth
 * lighting.
 *
 * This module is deliberately free of Three.js and DOM references. It takes
 * plain typed arrays in and returns plain typed arrays out, so the exact same
 * code runs on the main thread and inside a worker.
 *
 * Input is a *padded* 18^3 volume: the section's own 16^3 plus one block of
 * border on every side, copied from the neighbouring sections. The border is
 * what lets face culling, ambient occlusion and light sampling read across a
 * section boundary without any bounds checks in the hot loop.
 */

import {
  PADDED_SIZE,
  paddedIndex,
  SECTION_HEIGHT,
  TINT_STRIDE,
} from '../world/constants.js';
import { Bucket } from '../world/blocks.js';

export { Bucket, TINT_STRIDE };

const RENDER_CUBE = 1;
const RENDER_CROSS = 2;
const RENDER_LIQUID = 3;

/** How much a liquid's surface sits below a full block. */
const LIQUID_DROP = 0.125;

/**
 * Face table. `origin` is the block-local corner where (du, dv) = (0, 0);
 * `uVec`/`vVec` are the directions the quad's width and height run along.
 * Corner order is chosen per face so triangles wind counter-clockwise when
 * viewed from outside, which is what lets us keep backface culling on.
 */
const FACES = [
  { // 0: +X
    index: 0,
    normal: [1, 0, 0], origin: [1, 0, 0],
    uVec: [0, 0, 1], vVec: [0, 1, 0],
    cAxis: 0, uAxis: 2, vAxis: 1,
    corners: [[0, 0], [0, 1], [1, 1], [1, 0]],
  },
  { // 1: -X
    index: 1,
    normal: [-1, 0, 0], origin: [0, 0, 0],
    uVec: [0, 0, 1], vVec: [0, 1, 0],
    cAxis: 0, uAxis: 2, vAxis: 1,
    corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
  },
  { // 2: +Y
    index: 2,
    normal: [0, 1, 0], origin: [0, 1, 0],
    uVec: [1, 0, 0], vVec: [0, 0, 1],
    cAxis: 1, uAxis: 0, vAxis: 2,
    corners: [[0, 0], [0, 1], [1, 1], [1, 0]],
  },
  { // 3: -Y
    index: 3,
    normal: [0, -1, 0], origin: [0, 0, 0],
    uVec: [1, 0, 0], vVec: [0, 0, 1],
    cAxis: 1, uAxis: 0, vAxis: 2,
    corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
  },
  { // 4: +Z
    index: 4,
    normal: [0, 0, 1], origin: [0, 0, 1],
    uVec: [1, 0, 0], vVec: [0, 1, 0],
    cAxis: 2, uAxis: 0, vAxis: 1,
    corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
  },
  { // 5: -Z
    index: 5,
    normal: [0, 0, -1], origin: [0, 0, 0],
    uVec: [1, 0, 0], vVec: [0, 1, 0],
    cAxis: 2, uAxis: 0, vAxis: 1,
    corners: [[0, 0], [0, 1], [1, 1], [1, 0]],
  },
];

/**
 * Face index written into the shade attribute for plants. The shader treats it
 * as "no directional shading", so cross-quads stay evenly lit from every angle.
 */
export const FACE_FLAT = 6;

/**
 * Ambient occlusion ramp. Deliberately non-linear: the darkest step is a large
 * jump so inside corners read clearly, while the lighter steps stay subtle so
 * open ground does not look blotchy.
 */
const AO_LEVELS = new Float32Array([0.44, 0.66, 0.84, 1.0]);

const TINT_NONE = 0;
const TINT_GRASS = 1;
const TINT_FOLIAGE = 2;
const TINT_WATER = 3;

// ---------------------------------------------------------------------------
// Growable output buffers
// ---------------------------------------------------------------------------

class MeshBuffer {
  constructor(initialVertices = 2048) {
    this.capacity = initialVertices;
    this.count = 0;
    this.positions = new Float32Array(this.capacity * 3);
    this.uvs = new Float32Array(this.capacity * 2);
    this.layers = new Float32Array(this.capacity);
    // [ambient occlusion, skylight, blocklight, unused], all 0..255.
    this.shade = new Uint8Array(this.capacity * 4);
    this.tint = new Uint8Array(this.capacity * 4);

    this.indexCapacity = initialVertices * 2;
    this.indexCount = 0;
    this.indices = new Uint32Array(this.indexCapacity);
  }

  ensureVertices(extra) {
    if (this.count + extra <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < this.count + extra) capacity *= 2;
    this.positions = growFloat(this.positions, capacity * 3);
    this.uvs = growFloat(this.uvs, capacity * 2);
    this.layers = growFloat(this.layers, capacity);
    this.shade = growByte(this.shade, capacity * 4);
    this.tint = growByte(this.tint, capacity * 4);
    this.capacity = capacity;
  }

  ensureIndices(extra) {
    if (this.indexCount + extra <= this.indexCapacity) return;
    let capacity = this.indexCapacity;
    while (capacity < this.indexCount + extra) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(this.indices.subarray(0, this.indexCount));
    this.indices = next;
    this.indexCapacity = capacity;
  }

  pushVertex(x, y, z, u, v, layer, ao, sky, block, face, tr, tg, tb, sway) {
    const i = this.count;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.uvs[i * 2] = u;
    this.uvs[i * 2 + 1] = v;
    this.layers[i] = layer;
    this.shade[i * 4] = ao;
    this.shade[i * 4 + 1] = sky;
    this.shade[i * 4 + 2] = block;
    this.shade[i * 4 + 3] = face;
    this.tint[i * 4] = tr;
    this.tint[i * 4 + 1] = tg;
    this.tint[i * 4 + 2] = tb;
    this.tint[i * 4 + 3] = sway;
    this.count++;
  }

  pushQuadIndices(base, flip) {
    this.ensureIndices(6);
    const idx = this.indices;
    let n = this.indexCount;
    if (flip) {
      // Rotating the triangulation keeps the AO gradient symmetric; without
      // this, the diagonal of every shaded quad is visible as a hard crease.
      idx[n++] = base + 1; idx[n++] = base + 2; idx[n++] = base + 3;
      idx[n++] = base + 1; idx[n++] = base + 3; idx[n++] = base;
    } else {
      idx[n++] = base; idx[n++] = base + 1; idx[n++] = base + 2;
      idx[n++] = base; idx[n++] = base + 2; idx[n++] = base + 3;
    }
    this.indexCount = n;
  }

  isEmpty() {
    return this.indexCount === 0;
  }

  /** Trim to the used range and hand back transferable buffers. */
  finish() {
    return {
      positions: this.positions.slice(0, this.count * 3),
      uvs: this.uvs.slice(0, this.count * 2),
      layers: this.layers.slice(0, this.count),
      shade: this.shade.slice(0, this.count * 4),
      tint: this.tint.slice(0, this.count * 4),
      indices: this.indices.slice(0, this.indexCount),
      vertexCount: this.count,
    };
  }
}

function growFloat(source, size) {
  const next = new Float32Array(size);
  next.set(source);
  return next;
}

function growByte(source, size) {
  const next = new Uint8Array(size);
  next.set(source);
  return next;
}

// ---------------------------------------------------------------------------
// Reusable scratch state
// ---------------------------------------------------------------------------

const MASK_AREA = SECTION_HEIGHT * SECTION_HEIGHT;

const mask = {
  tile: new Int16Array(MASK_AREA),
  ao: new Uint8Array(MASK_AREA * 4),
  sky: new Uint8Array(MASK_AREA * 4),
  block: new Uint8Array(MASK_AREA * 4),
  tint: new Uint8Array(MASK_AREA * 3),
  lowered: new Uint8Array(MASK_AREA),
  bucket: new Uint8Array(MASK_AREA),
  sway: new Uint8Array(MASK_AREA),
};

function maskEquals(a, b) {
  if (mask.tile[a] !== mask.tile[b]) return false;
  if (mask.lowered[a] !== mask.lowered[b]) return false;
  if (mask.bucket[a] !== mask.bucket[b]) return false;
  if (mask.sway[a] !== mask.sway[b]) return false;
  const a4 = a * 4;
  const b4 = b * 4;
  for (let k = 0; k < 4; k++) {
    if (mask.ao[a4 + k] !== mask.ao[b4 + k]) return false;
    if (mask.sky[a4 + k] !== mask.sky[b4 + k]) return false;
    if (mask.block[a4 + k] !== mask.block[b4 + k]) return false;
  }
  const a3 = a * 3;
  const b3 = b * 3;
  return mask.tint[a3] === mask.tint[b3]
    && mask.tint[a3 + 1] === mask.tint[b3 + 1]
    && mask.tint[a3 + 2] === mask.tint[b3 + 2];
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

/**
 * Build geometry for one section.
 *
 * @param {Uint16Array} blocks  padded 18^3 block ids
 * @param {Uint8Array}  light   padded 18^3 packed light (sky<<4 | block)
 * @param {Uint8Array}  tint    18x18 columns x 9 bytes (grass/foliage/water RGB)
 * @param {object}      tables  flat block property tables
 * @returns {{opaque:object|null, cutout:object|null, transparent:object|null}}
 */
export function meshSection(blocks, light, tint, tables) {
  const buffers = [new MeshBuffer(), new MeshBuffer(), new MeshBuffer()];

  meshCubeFaces(blocks, light, tint, tables, buffers);
  meshCrossBlocks(blocks, light, tint, tables, buffers[Bucket.CUTOUT]);

  return {
    opaque: buffers[Bucket.OPAQUE].isEmpty() ? null : buffers[Bucket.OPAQUE].finish(),
    cutout: buffers[Bucket.CUTOUT].isEmpty() ? null : buffers[Bucket.CUTOUT].finish(),
    transparent: buffers[Bucket.TRANSPARENT].isEmpty() ? null : buffers[Bucket.TRANSPARENT].finish(),
  };
}

function meshCubeFaces(blocks, light, tint, tables, buffers) {
  const voxel = [0, 0, 0];

  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const { cAxis, uAxis, vAxis, normal } = face;

    for (let slice = 0; slice < SECTION_HEIGHT; slice++) {
      mask.tile.fill(-1);
      let any = false;

      for (let b = 0; b < SECTION_HEIGHT; b++) {
        for (let a = 0; a < SECTION_HEIGHT; a++) {
          voxel[cAxis] = slice;
          voxel[uAxis] = a;
          voxel[vAxis] = b;
          const x = voxel[0];
          const y = voxel[1];
          const z = voxel[2];

          const id = blocks[paddedIndex(x, y, z)];
          if (id === 0) continue;

          const render = tables.render[id];
          if (render !== RENDER_CUBE && render !== RENDER_LIQUID) continue;

          const nx = x + normal[0];
          const ny = y + normal[1];
          const nz = z + normal[2];
          const neighbor = blocks[paddedIndex(nx, ny, nz)];
          if (!faceVisible(id, neighbor, tables)) continue;

          const m = b * SECTION_HEIGHT + a;
          mask.tile[m] = tables.tiles[id * 6 + f];
          mask.bucket[m] = tables.bucket[id];
          mask.sway[m] = tables.sway[id];

          // A liquid whose top is exposed sits slightly below a full block, so
          // the surface is visible from above rather than flush with the shore.
          const above = blocks[paddedIndex(x, y + 1, z)];
          mask.lowered[m] = render === RENDER_LIQUID && above !== id ? 1 : 0;

          sampleCorners(blocks, light, tables, face, x, y, z, m);
          writeTint(tint, tables, id, x, z, m);
          any = true;
        }
      }

      if (any) emitGreedyQuads(face, slice, buffers);
    }
  }
}

/**
 * Decide whether a block's face toward `neighbor` should be drawn.
 * Opaque neighbours hide everything; matching self-culling blocks (water,
 * glass, ice) hide each other so large bodies do not build interior walls.
 */
function faceVisible(id, neighbor, tables) {
  if (neighbor === 0) return true;
  if (tables.opaque[neighbor]) return false;
  if (id === neighbor && tables.selfCull[id]) return false;
  return true;
}

/** Compute AO and smooth light for all four corners of one face. */
function sampleCorners(blocks, light, tables, face, x, y, z, m) {
  const { normal, uVec, vVec, corners } = face;
  const fx = x + normal[0];
  const fy = y + normal[1];
  const fz = z + normal[2];

  for (let c = 0; c < 4; c++) {
    const du = corners[c][0] === 0 ? -1 : 1;
    const dv = corners[c][1] === 0 ? -1 : 1;

    const s1x = fx + uVec[0] * du, s1y = fy + uVec[1] * du, s1z = fz + uVec[2] * du;
    const s2x = fx + vVec[0] * dv, s2y = fy + vVec[1] * dv, s2z = fz + vVec[2] * dv;
    const cnx = s1x + vVec[0] * dv, cny = s1y + vVec[1] * dv, cnz = s1z + vVec[2] * dv;

    const i0 = paddedIndex(fx, fy, fz);
    const i1 = paddedIndex(s1x, s1y, s1z);
    const i2 = paddedIndex(s2x, s2y, s2z);
    const i3 = paddedIndex(cnx, cny, cnz);

    const o1 = tables.opaque[blocks[i1]];
    const o2 = tables.opaque[blocks[i2]];
    const o3 = tables.opaque[blocks[i3]];

    // Two occluded sides fully enclose the corner; the diagonal cannot make it
    // any darker, and testing it would produce a lighter value than the sides.
    const level = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
    mask.ao[m * 4 + c] = Math.round(AO_LEVELS[level] * 255);

    // Smooth lighting: average the light of the four cells touching this
    // corner, ignoring solid ones so light does not bleed out of walls.
    let skySum = 0;
    let blockSum = 0;
    let samples = 0;
    for (const i of [i0, i1, i2, i3]) {
      if (tables.opaque[blocks[i]]) continue;
      const packed = light[i];
      skySum += packed >> 4;
      blockSum += packed & 15;
      samples++;
    }
    if (samples === 0) {
      const packed = light[i0];
      skySum = packed >> 4;
      blockSum = packed & 15;
      samples = 1;
    }
    mask.sky[m * 4 + c] = Math.round((skySum / samples) * 17);
    mask.block[m * 4 + c] = Math.round((blockSum / samples) * 17);
  }
}

function writeTint(tint, tables, id, x, z, m) {
  const kind = tables.tint[id];
  const m3 = m * 3;
  if (kind === TINT_NONE) {
    mask.tint[m3] = 255;
    mask.tint[m3 + 1] = 255;
    mask.tint[m3 + 2] = 255;
    return;
  }
  const column = ((z + 1) * PADDED_SIZE + (x + 1)) * TINT_STRIDE;
  const offset = kind === TINT_GRASS ? 0 : kind === TINT_FOLIAGE ? 3 : 6;
  mask.tint[m3] = tint[column + offset];
  mask.tint[m3 + 1] = tint[column + offset + 1];
  mask.tint[m3 + 2] = tint[column + offset + 2];
}

/**
 * Merge the mask into as few rectangles as possible, then emit each rectangle
 * as a single quad. Cells only merge when their texture, lighting, ambient
 * occlusion and tint all match exactly, so a merged quad is always flat-shaded
 * across its whole area and no interpolation error is introduced.
 */
function emitGreedyQuads(face, slice, buffers) {
  const { cAxis, uAxis, vAxis } = face;
  const position = [0, 0, 0];

  for (let b = 0; b < SECTION_HEIGHT; b++) {
    for (let a = 0; a < SECTION_HEIGHT;) {
      const m = b * SECTION_HEIGHT + a;
      if (mask.tile[m] < 0) {
        a++;
        continue;
      }

      // Extend along the u axis.
      let width = 1;
      while (a + width < SECTION_HEIGHT && maskEquals(m, m + width)) width++;

      // Extend along the v axis, one full row at a time.
      let height = 1;
      outer: while (b + height < SECTION_HEIGHT) {
        const rowStart = (b + height) * SECTION_HEIGHT + a;
        for (let k = 0; k < width; k++) {
          if (mask.tile[rowStart + k] < 0 || !maskEquals(m, rowStart + k)) break outer;
        }
        height++;
      }

      position[cAxis] = slice;
      position[uAxis] = a;
      position[vAxis] = b;

      emitQuad(buffers[mask.bucket[m]], face, position, width, height, m);

      // Clear the consumed rectangle so it is not emitted again.
      for (let dv = 0; dv < height; dv++) {
        const rowStart = (b + dv) * SECTION_HEIGHT + a;
        for (let du = 0; du < width; du++) mask.tile[rowStart + du] = -1;
      }

      a += width;
    }
  }
}

function emitQuad(buffer, face, position, width, height, m) {
  const { origin, uVec, vVec, corners } = face;
  const isVertical = face.cAxis !== 1;
  const lowered = mask.lowered[m] === 1;

  // A lowered liquid loses height off its top edge. For side faces that means
  // shortening the quad; for the top face it means dropping the whole quad.
  const vExtent = lowered && isVertical ? height - LIQUID_DROP : height;
  const yDrop = lowered && !isVertical ? LIQUID_DROP : 0;

  const layer = mask.tile[m];
  const base = buffer.count;
  buffer.ensureVertices(4);

  const m3 = m * 3;
  const tr = mask.tint[m3];
  const tg = mask.tint[m3 + 1];
  const tb = mask.tint[m3 + 2];

  for (let c = 0; c < 4; c++) {
    const du = corners[c][0];
    const dv = corners[c][1];
    const u = du * width;
    const v = dv * vExtent;

    const x = position[0] + origin[0] + uVec[0] * u + vVec[0] * v;
    const y = position[1] + origin[1] + uVec[1] * u + vVec[1] * v - yDrop;
    const z = position[2] + origin[2] + uVec[2] * u + vVec[2] * v;

    buffer.pushVertex(
      x, y, z,
      u, v,
      layer,
      mask.ao[m * 4 + c],
      mask.sky[m * 4 + c],
      mask.block[m * 4 + c],
      face.index,
      tr, tg, tb,
      mask.sway[m],
    );
  }

  // Flip the diagonal when the AO gradient runs across it, so the quad's
  // shading stays symmetric instead of creasing along one triangle edge.
  const a0 = mask.ao[m * 4];
  const a1 = mask.ao[m * 4 + 1];
  const a2 = mask.ao[m * 4 + 2];
  const a3 = mask.ao[m * 4 + 3];
  buffer.pushQuadIndices(base, a0 + a2 > a1 + a3);
}

// ---------------------------------------------------------------------------
// Cross-shaped blocks (grass, flowers, torches)
// ---------------------------------------------------------------------------

/** Inset so plants do not z-fight with the block faces beside them. */
const CROSS_INSET = 0.1465;

/**
 * Plants are drawn as two intersecting quads. They are emitted per block rather
 * than greedily merged, and drawn double-sided by the cutout material so the
 * back of each quad is visible.
 */
function meshCrossBlocks(blocks, light, tint, tables, buffer) {
  for (let y = 0; y < SECTION_HEIGHT; y++) {
    for (let z = 0; z < SECTION_HEIGHT; z++) {
      for (let x = 0; x < SECTION_HEIGHT; x++) {
        const id = blocks[paddedIndex(x, y, z)];
        if (id === 0 || tables.render[id] !== RENDER_CROSS) continue;

        const layer = tables.tiles[id * 6 + 2];
        const packed = light[paddedIndex(x, y, z)];
        const sky = Math.round((packed >> 4) * 17);
        const block = Math.round((packed & 15) * 17);

        let tr = 255;
        let tg = 255;
        let tb = 255;
        const kind = tables.tint[id];
        if (kind !== TINT_NONE) {
          const column = ((z + 1) * PADDED_SIZE + (x + 1)) * TINT_STRIDE;
          const offset = kind === TINT_GRASS ? 0 : kind === TINT_FOLIAGE ? 3 : 6;
          tr = tint[column + offset];
          tg = tint[column + offset + 1];
          tb = tint[column + offset + 2];
        }

        const lo = CROSS_INSET;
        const hi = 1 - CROSS_INSET;
        const sway = tables.sway[id];

        // Two quads along the block's diagonals.
        pushCrossQuad(buffer, x + lo, y, z + lo, x + hi, y + 1, z + hi, layer, sky, block, tr, tg, tb, sway);
        pushCrossQuad(buffer, x + hi, y, z + lo, x + lo, y + 1, z + hi, layer, sky, block, tr, tg, tb, sway);
      }
    }
  }
}

function pushCrossQuad(buffer, x0, y0, z0, x1, y1, z1, layer, sky, block, tr, tg, tb, sway) {
  const base = buffer.count;
  buffer.ensureVertices(4);
  // Plants get no ambient occlusion; a flat 255 keeps them evenly lit.
  const ao = 255;
  // Only the top pair sways, so the plant stays rooted while its tip moves.
  buffer.pushVertex(x0, y0, z0, 0, 0, layer, ao, sky, block, FACE_FLAT, tr, tg, tb, 0);
  buffer.pushVertex(x1, y0, z1, 1, 0, layer, ao, sky, block, FACE_FLAT, tr, tg, tb, 0);
  buffer.pushVertex(x1, y1, z1, 1, 1, layer, ao, sky, block, FACE_FLAT, tr, tg, tb, sway);
  buffer.pushVertex(x0, y1, z0, 0, 1, layer, ao, sky, block, FACE_FLAT, tr, tg, tb, sway);
  buffer.pushQuadIndices(base, false);
}

// ---------------------------------------------------------------------------
// Padded volume extraction
// ---------------------------------------------------------------------------

/**
 * Copy a section plus one block of border from its neighbours into padded
 * arrays. `sample(x, y, z)` takes chunk-local x/z (which may be -1 or 16) and
 * absolute y, and returns `[blockId, packedLight]`.
 */
export function buildPaddedVolume(sample, sectionY, out) {
  const blocks = out?.blocks ?? new Uint16Array(PADDED_SIZE ** 3);
  const light = out?.light ?? new Uint8Array(PADDED_SIZE ** 3);
  const baseY = sectionY * SECTION_HEIGHT;

  for (let y = -1; y <= SECTION_HEIGHT; y++) {
    for (let z = -1; z <= SECTION_HEIGHT; z++) {
      for (let x = -1; x <= SECTION_HEIGHT; x++) {
        const i = paddedIndex(x, y, z);
        const [id, packed] = sample(x, baseY + y, z);
        blocks[i] = id;
        light[i] = packed;
      }
    }
  }
  return { blocks, light };
}
