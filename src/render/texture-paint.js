/**
 * Procedural texture drawing toolkit.
 *
 * Every block texture in the game is painted at runtime by composing these
 * primitives, so the build ships with zero image assets. That keeps the whole
 * game self-contained and removes every asset-path and CORS failure mode.
 *
 * All generators are *tileable*: greedy meshing produces quads that span many
 * blocks and rely on repeat wrapping, so a texture with a visible seam would
 * show up as a grid across every large surface.
 */

export const TILE = 32;

/** A 32x32 RGBA canvas with helpers for the patterns block textures need. */
export class Painter {
  constructor(rand, size = TILE) {
    this.size = size;
    this.rand = rand;
    this.px = new Uint8ClampedArray(size * size * 4);
  }

  index(x, y) {
    return (y * this.size + x) * 4;
  }

  set(x, y, r, g, b, a = 255) {
    const i = this.index(x, y);
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
    this.px[i + 3] = a;
  }

  get(x, y) {
    const i = this.index(x, y);
    return [this.px[i], this.px[i + 1], this.px[i + 2], this.px[i + 3]];
  }

  /** Multiply an existing pixel's brightness, leaving alpha untouched. */
  shade(x, y, factor) {
    const i = this.index(x, y);
    this.px[i] *= factor;
    this.px[i + 1] *= factor;
    this.px[i + 2] *= factor;
  }

  /** Blend a colour over an existing pixel. */
  blend(x, y, [r, g, b], alpha) {
    const i = this.index(x, y);
    this.px[i] += (r - this.px[i]) * alpha;
    this.px[i + 1] += (g - this.px[i + 1]) * alpha;
    this.px[i + 2] += (b - this.px[i + 2]) * alpha;
  }

  fill([r, g, b], a = 255) {
    for (let i = 0; i < this.px.length; i += 4) {
      this.px[i] = r;
      this.px[i + 1] = g;
      this.px[i + 2] = b;
      this.px[i + 3] = a;
    }
    return this;
  }

  clear() {
    this.px.fill(0);
    return this;
  }

  forEach(fn) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) fn(x, y, this);
    }
    return this;
  }

  /**
   * Multiply every pixel by a tileable fbm field. `strength` of 0.2 means the
   * texture ranges from 0.8x to 1.2x its base brightness.
   */
  grain(strength = 0.16, cells = 8, octaves = 3) {
    const field = tileableFbm(this.size, cells, octaves, this.rand);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const n = field[y * this.size + x];
        this.shade(x, y, 1 + (n - 0.5) * 2 * strength);
      }
    }
    return this;
  }

  /**
   * Quantised per-texel noise.
   *
   * `grain` builds smooth clouds from fbm, which is right for large soft
   * variation but reads as an airbrush at close range. This is the other half:
   * hard-edged noise on a `cell`-pixel grid, which is what gives hand-drawn
   * block art its crunch. At TILE 32 a cell of 2 is one pixel of a classic
   * 16x16 texture.
   */
  pixelGrain(strength = 0.12, cell = 2) {
    const cells = Math.max(1, Math.round(this.size / cell));
    const tones = new Float32Array(cells * cells);
    for (let i = 0; i < tones.length; i++) tones[i] = 1 + (this.rand() - 0.5) * 2 * strength;
    for (let y = 0; y < this.size; y++) {
      const cy = Math.min(cells - 1, Math.floor((y / this.size) * cells));
      for (let x = 0; x < this.size; x++) {
        const cx = Math.min(cells - 1, Math.floor((x / this.size) * cells));
        this.shade(x, y, tones[cy * cells + cx]);
      }
    }
    return this;
  }

  /**
   * Blocky clumps of a colour, snapped to a `cell`-pixel grid and wrapped at
   * the edges.
   *
   * The square edges are the point. Soft blobs read as stains on a surface;
   * clumps of whole texels read as lumps *of* it — which is the difference
   * between dirt that looks painted and dirt that looks like dirt.
   */
  clusters(color, count, alpha = 0.4, minCells = 1, maxCells = 3, cell = 2) {
    for (let i = 0; i < count; i++) {
      const w = (minCells + Math.floor(this.rand() * (maxCells - minCells + 1))) * cell;
      const h = (minCells + Math.floor(this.rand() * (maxCells - minCells + 1))) * cell;
      const x0 = Math.floor(this.rand() * (this.size / cell)) * cell;
      const y0 = Math.floor(this.rand() * (this.size / cell)) * cell;
      const strength = alpha * (0.65 + this.rand() * 0.7);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          this.blend(mod(x0 + x, this.size), mod(y0 + y, this.size), color, strength);
        }
      }
    }
    return this;
  }

  /** Scatter individual pixels of a colour, e.g. sand sparkle or ore flecks. */
  speckle(color, count, alpha = 1) {
    for (let i = 0; i < count; i++) {
      const x = Math.floor(this.rand() * this.size);
      const y = Math.floor(this.rand() * this.size);
      this.blend(x, y, color, alpha);
    }
    return this;
  }

  /** Soft round blobs, wrapping at the edges so the result still tiles. */
  blobs(color, count, radius, alpha = 0.5) {
    for (let i = 0; i < count; i++) {
      const cx = this.rand() * this.size;
      const cy = this.rand() * this.size;
      const r = radius * (0.6 + this.rand() * 0.8);
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          const d = wrappedDistance(x, y, cx, cy, this.size);
          if (d < r) {
            const falloff = 1 - d / r;
            this.blend(x, y, color, alpha * falloff * falloff);
          }
        }
      }
    }
    return this;
  }

  /**
   * A lit top edge and shadowed bottom edge. This is the single cheapest thing
   * that makes flat colours read as solid blocks rather than paint swatches.
   */
  bevel(top = 1.14, bottom = 0.84, thickness = 1) {
    for (let x = 0; x < this.size; x++) {
      for (let t = 0; t < thickness; t++) {
        this.shade(x, t, top);
        this.shade(x, this.size - 1 - t, bottom);
      }
    }
    return this;
  }

  /** Darken the tile's outline, giving neighbouring blocks a visible joint. */
  outline(factor = 0.9) {
    for (let i = 0; i < this.size; i++) {
      this.shade(i, 0, factor);
      this.shade(i, this.size - 1, factor);
      this.shade(0, i, factor);
      this.shade(this.size - 1, i, factor);
    }
    return this;
  }

  /** Vertical wood-grain streaks. */
  streaks(dark, count = 10, alpha = 0.35) {
    for (let i = 0; i < count; i++) {
      const x0 = this.rand() * this.size;
      const width = 0.8 + this.rand() * 2.2;
      const wobble = 0.6 + this.rand() * 1.6;
      const phase = this.rand() * Math.PI * 2;
      for (let y = 0; y < this.size; y++) {
        const cx = x0 + Math.sin((y / this.size) * Math.PI * 2 + phase) * wobble;
        for (let dx = -2; dx <= 2; dx++) {
          const x = Math.round(cx + dx);
          const d = Math.abs(cx + dx - cx);
          if (d > width) continue;
          this.blend(mod(x, this.size), y, dark, alpha * (1 - d / width));
        }
      }
    }
    return this;
  }

  /** Concentric growth rings, for log end grain. */
  rings(dark, ringCount = 5, alpha = 0.4) {
    const cx = this.size / 2 + (this.rand() - 0.5) * 3;
    const cy = this.size / 2 + (this.rand() - 0.5) * 3;
    const jitter = tileableFbm(this.size, 4, 2, this.rand);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy) + jitter[y * this.size + x] * 2.5;
        const ring = Math.sin((d / this.size) * Math.PI * 2 * ringCount);
        if (ring > 0.45) this.blend(x, y, dark, alpha * (ring - 0.45) / 0.55);
      }
    }
    return this;
  }

  /** Horizontal plank boards separated by dark grooves. */
  planks(groove, boards = 4, alpha = 0.75) {
    const step = this.size / boards;
    for (let y = 0; y < this.size; y++) {
      const inGroove = Math.abs((y % step) - 0) < 1;
      if (inGroove) {
        for (let x = 0; x < this.size; x++) this.blend(x, y, groove, alpha);
      }
      // Slight per-board tone variation so boards read as separate pieces.
      const board = Math.floor(y / step);
      const tone = 1 + ((board * 37) % 5 - 2) * 0.022;
      for (let x = 0; x < this.size; x++) this.shade(x, y, tone);
    }
    return this;
  }

  /** Offset brick courses with mortar lines. */
  bricks(mortar, rows = 4, alpha = 0.9) {
    const rowHeight = this.size / rows;
    const brickWidth = this.size / 2;
    for (let y = 0; y < this.size; y++) {
      const row = Math.floor(y / rowHeight);
      const onRowLine = y % rowHeight < 1.4;
      const offset = (row % 2) * (brickWidth / 2);
      for (let x = 0; x < this.size; x++) {
        const onColLine = mod(x - offset, brickWidth) < 1.4;
        if (onRowLine || onColLine) this.blend(x, y, mortar, alpha);
      }
      const tone = 1 + ((row * 53) % 7 - 3) * 0.018;
      for (let x = 0; x < this.size; x++) this.shade(x, y, tone);
    }
    return this;
  }

  /**
   * Irregular stone cobbles: a wrapped Voronoi diagram where each cell gets its
   * own tone and cell borders darken into mortar.
   */
  cobbles(mortar, cells = 3, mortarWidth = 0.14, toneSpread = 0.16) {
    const { cellId, edge } = tileableVoronoi(this.size, cells, this.rand);
    const tones = [];
    for (let i = 0; i < cells * cells; i++) tones.push(1 + (this.rand() - 0.5) * 2 * toneSpread);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const i = y * this.size + x;
        this.shade(x, y, tones[cellId[i] % tones.length]);
        if (edge[i] < mortarWidth) {
          this.blend(x, y, mortar, 1 - edge[i] / mortarWidth);
        }
      }
    }
    return this;
  }

  /** Overlay ore flecks in irregular clusters, as found in real ore veins. */
  oreVein(color, highlight, clusters = 4) {
    for (let c = 0; c < clusters; c++) {
      const cx = this.rand() * this.size;
      const cy = this.rand() * this.size;
      const r = 2.6 + this.rand() * 2.6;
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          const d = wrappedDistance(x, y, cx, cy, this.size);
          if (d > r) continue;
          // Ragged edge rather than a clean circle.
          if (this.rand() < 0.32 + 0.5 * (d / r)) continue;
          this.blend(x, y, color, 1);
          // A lit pixel up-left of each fleck reads as a facet catching light.
          if (this.rand() < 0.35) {
            this.blend(mod(x - 1, this.size), mod(y - 1, this.size), highlight, 0.75);
          }
        }
      }
    }
    return this;
  }

  /** Draw an opaque rectangle (used for the built-block details). */
  rect(x0, y0, w, h, color, alpha = 1) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        this.blend(x, y, color, alpha);
        const i = this.index(x, y);
        this.px[i + 3] = 255;
      }
    }
    return this;
  }

  /** Stroke a rectangle outline. */
  strokeRect(x0, y0, w, h, color, alpha = 1) {
    for (let x = x0; x < x0 + w; x++) {
      this.blendSafe(x, y0, color, alpha);
      this.blendSafe(x, y0 + h - 1, color, alpha);
    }
    for (let y = y0; y < y0 + h; y++) {
      this.blendSafe(x0, y, color, alpha);
      this.blendSafe(x0 + w - 1, y, color, alpha);
    }
    return this;
  }

  blendSafe(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.blend(x, y, color, alpha);
  }

  /**
   * Keep only pixels where `mask(x, y)` is true, clearing the rest to
   * transparent. Used to cut plant silhouettes out of a painted field.
   */
  maskTo(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!mask(x, y)) {
          const i = this.index(x, y);
          this.px[i + 3] = 0;
        }
      }
    }
    return this;
  }

  /** Copy this painter's pixels into a destination layer of an array texture. */
  writeTo(target, offset) {
    target.set(this.px, offset);
  }
}

// ---------------------------------------------------------------------------
// Tileable field generators
// ---------------------------------------------------------------------------

function mod(a, n) {
  return ((a % n) + n) % n;
}

/** Distance on a torus, so patterns wrap across tile edges. */
function wrappedDistance(x, y, cx, cy, size) {
  let dx = Math.abs(x - cx);
  let dy = Math.abs(y - cy);
  if (dx > size / 2) dx = size - dx;
  if (dy > size / 2) dy = size - dy;
  return Math.sqrt(dx * dx + dy * dy);
}

function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Value noise on a wrapping lattice. `cells` must divide `size` for the result
 * to tile cleanly.
 */
export function tileableValueNoise(size, cells, rand) {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const fy = y * scale;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smootherstep(fx - x0);
      const ty = smootherstep(fy - y0);
      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const a = lattice[(y0 % cells) * cells + (x0 % cells)];
      const b = lattice[(y0 % cells) * cells + x1];
      const c = lattice[y1 * cells + (x0 % cells)];
      const d = lattice[y1 * cells + x1];
      const top = a + (b - a) * tx;
      const bottom = c + (d - c) * tx;
      out[y * size + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** Summed octaves of tileable value noise, normalised to [0, 1]. */
export function tileableFbm(size, baseCells, octaves, rand) {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let norm = 0;
  let cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const layer = tileableValueNoise(size, cells, rand);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    cells = Math.min(size, cells * 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * Wrapped Voronoi. Returns the owning cell per pixel and a normalised distance
 * to the nearest cell boundary (0 at a border, 1 deep inside a cell).
 */
export function tileableVoronoi(size, cells, rand) {
  const points = [];
  const cellSize = size / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      points.push({
        x: (cx + 0.15 + rand() * 0.7) * cellSize,
        y: (cy + 0.15 + rand() * 0.7) * cellSize,
        id: cy * cells + cx,
      });
    }
  }

  const cellId = new Int32Array(size * size);
  const edge = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let best = Infinity;
      let second = Infinity;
      let bestId = 0;
      for (const p of points) {
        const d = wrappedDistance(x, y, p.x, p.y, size);
        if (d < best) {
          second = best;
          best = d;
          bestId = p.id;
        } else if (d < second) {
          second = d;
        }
      }
      const i = y * size + x;
      cellId[i] = bestId;
      // Difference between the two nearest sites approaches zero at a border.
      edge[i] = Math.min(1, (second - best) / cellSize);
    }
  }
  return { cellId, edge };
}
