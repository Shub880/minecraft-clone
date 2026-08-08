/**
 * Seeded pseudo-random utilities.
 *
 * All world generation randomness flows through here. The important property is
 * order-independence: features are seeded from their world position rather than
 * from a streaming generator, so a chunk generates identically no matter which
 * chunks were visited before it.
 */

/** Final avalanche mix for a 32-bit integer (murmur3 finalizer). */
export function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash an arbitrary string into a well-distributed 32-bit unsigned integer. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mix32(h);
}

/**
 * Turn user seed input into a numeric seed. Numeric strings are used directly
 * so players can share "12345" style seeds; anything else is hashed.
 */
export function parseSeed(input) {
  const text = String(input ?? '').trim();
  if (text === '') return (Math.random() * 0xffffffff) >>> 0;
  if (/^-?\d+$/.test(text)) return Math.abs(Number(text)) >>> 0;
  return hashString(text);
}

/** Fast, well-distributed 32-bit PRNG. Returns a function yielding [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positional hash for 2D world coordinates. */
export function hash2(x, z, seed) {
  let h = seed >>> 0;
  h = (h ^ Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  h = (h ^ Math.imul(z | 0, 0x165667b1)) >>> 0;
  return mix32(h);
}

/** Positional hash for 3D world coordinates. */
export function hash3(x, y, z, seed) {
  let h = seed >>> 0;
  h = (h ^ Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  h = (h ^ Math.imul(y | 0, 0x85ebca6b)) >>> 0;
  h = (h ^ Math.imul(z | 0, 0x165667b1)) >>> 0;
  return mix32(h);
}

/** A PRNG deterministically seeded at a 2D world position. */
export function rngAt2(x, z, seed, salt = 0) {
  return mulberry32(hash2(x, z, (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0));
}

/** A PRNG deterministically seeded at a 3D world position. */
export function rngAt3(x, y, z, seed, salt = 0) {
  return mulberry32(hash3(x, y, z, (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0));
}

/** Uniform float in [min, max). */
export function randRange(rand, min, max) {
  return min + rand() * (max - min);
}

/** Uniform integer in [min, max] inclusive. */
export function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

/** Pick a random element from an array. */
export function randPick(rand, array) {
  return array[Math.floor(rand() * array.length) % array.length];
}
