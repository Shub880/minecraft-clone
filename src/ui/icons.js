/**
 * Inventory icons.
 *
 * Blocks are drawn as small isometric cubes composed from the same painted
 * textures the world uses, so an icon is always an accurate preview of what
 * will be placed — including biome tint and face shading.
 *
 * The three visible faces are drawn by mapping each texture's unit square
 * through an affine transform, which is cheaper and sharper than rendering a
 * real cube to an offscreen WebGL target for every slot in the picker.
 *
 * Everything is cached: the picker shows sixty blocks at once and rebuilds on
 * every search keystroke.
 */

import { paintTexturePixels, CUTOUT_TEXTURES } from '../render/atlas.js';
import { BLOCKS, Render, Tint, getBlock } from '../world/blocks.js';
import { BIOMES, BiomeId } from '../world/worldgen/biomes.js';

/** Brightness per visible face: top, left, right. Matches the world's ramp. */
const FACE_SHADE = { top: 1, left: 0.72, right: 0.86 };

const faceCache = new Map();
const iconCache = new Map();

/**
 * A block's default tint, taken from the plains biome so icons match what the
 * player mostly sees. Water uses its own palette entry.
 */
function tintFor(block) {
  const plains = BIOMES[BiomeId.PLAINS];
  if (block.tint === Tint.GRASS) return plains.grass.map((c) => c / 255);
  if (block.tint === Tint.FOLIAGE) return plains.foliage.map((c) => c / 255);
  if (block.tint === Tint.WATER) return [0.75, 0.86, 1];
  return [1, 1, 1];
}

/**
 * Flatten one painted texture into a drawable canvas, applying the tint mask
 * and a face brightness.
 *
 * Opaque textures store a *tint mask* in alpha (0 = tint this pixel fully),
 * which is exactly what the world shader does with `mix(tint, 1, texel.a)`.
 * Reproducing it here is what makes a grass block's icon green on top and
 * brown on the sides.
 */
function faceCanvas(name, tint, shade) {
  const key = `${name}|${tint.join(',')}|${shade}`;
  const hit = faceCache.get(key);
  if (hit) return hit;

  const pixels = paintTexturePixels(name);
  const size = Math.round(Math.sqrt(pixels.length / 4));
  const isCutout = CUTOUT_TEXTURES.has(name);
  const out = new Uint8ClampedArray(pixels.length);

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const multiplier = isCutout ? tint[c] : tint[c] * (1 - alpha) + alpha;
      out[i + c] = pixels[i + c] * multiplier * shade;
    }
    out[i + 3] = isCutout ? pixels[i + 3] : 255;
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').putImageData(new ImageData(out, size, size), 0, 0);
  faceCache.set(key, canvas);
  return canvas;
}

/** Draw a texture into a parallelogram defined by an affine basis. */
function drawFace(ctx, canvas, a, b, c, d, e, f) {
  ctx.save();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(canvas, 0, 0, 1, 1);
  ctx.restore();
}

/**
 * Icon for a block id, as a fresh `<img>` backed by a cached data URL.
 *
 * An element can only be in one place in the document, so handing out a shared
 * canvas would make the hotbar's stone icon vanish the moment the inventory
 * drew the same block. Caching the encoded image instead keeps the expensive
 * part shared and the cheap part per-use.
 *
 * @param {number} id
 * @param {number} size  CSS pixel size of the returned image
 * @returns {HTMLImageElement}
 */
export function blockIcon(id, size = 44) {
  const key = `${id}@${size}`;
  let url = iconCache.get(key);
  if (!url) {
    url = renderIcon(id, size);
    iconCache.set(key, url);
  }

  const image = new Image(size, size);
  image.src = url;
  image.alt = '';
  image.draggable = false;
  return image;
}

function renderIcon(id, size) {
  const canvas = document.createElement('canvas');
  // Draw at 2x and let CSS scale down, so icons stay crisp on dense displays.
  const scale = 2;
  canvas.width = size * scale;
  canvas.height = size * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const block = BLOCKS[id];
  if (block && id !== 0) {
    const tint = tintFor(block);
    if (block.render === Render.CROSS) drawFlat(ctx, block, tint, size * scale);
    else drawCube(ctx, block, tint, size * scale);
  }

  return canvas.toDataURL('image/png');
}

/** Plants and torches are flat quads in the world, so they are flat here too. */
function drawFlat(ctx, block, tint, size) {
  const canvas = faceCanvas(block.textures[2], tint, 1);
  const inset = size * 0.08;
  ctx.drawImage(canvas, inset, inset, size - inset * 2, size - inset * 2);
}

/**
 * An isometric cube.
 *
 * Layout, in a unit square scaled by `size`: the top face is the diamond
 * spanning the upper half, and the two side faces fill the lower half. Each
 * face's transform maps texture (0,0)..(1,1) onto its parallelogram.
 */
function drawCube(ctx, block, tint, size) {
  const s = size * 0.92;
  const originX = size * 0.04;
  const originY = size * 0.06;

  const top = faceCanvas(block.textures[2], tint, FACE_SHADE.top);
  const left = faceCanvas(block.textures[1], tint, FACE_SHADE.left);
  const right = faceCanvas(block.textures[4], tint, FACE_SHADE.right);

  const half = s / 2;
  const quarter = s / 4;

  // Top: (0,0) at the left corner, U to the apex, V to the right corner.
  drawFace(ctx, top, half, -quarter, half, quarter, originX, originY + quarter);
  // Left: down-right along U, straight down along V.
  drawFace(ctx, left, half, quarter, 0, half, originX, originY + quarter);
  // Right: up-right along U, straight down along V.
  drawFace(ctx, right, half, -quarter, 0, half, originX + half, originY + half);
}

/** Display name for a block id, for tooltips and the held-item label. */
export function blockName(id) {
  return getBlock(id).display;
}

/** Drop every cached canvas. Only needed if the palette is ever re-themed. */
export function clearIconCache() {
  faceCache.clear();
  iconCache.clear();
}
