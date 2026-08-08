/**
 * Voxel ray traversal.
 *
 * Amanatides & Woo's algorithm: step from one block to the next along the ray,
 * always crossing whichever axis boundary is nearest. It visits every block the
 * ray actually passes through, in order, with no sampling gaps — which matters
 * because a stepped-sample raycast will happily miss a one-block-thick wall at
 * a shallow angle and let the player place blocks inside terrain.
 *
 * The face normal falls out of which axis was crossed last, so the caller gets
 * the placement position for free.
 */

import { AIR, Render } from '../world/blocks.js';

/**
 * Distance along the ray, in units of `direction`, to the first block boundary.
 * Returns Infinity for a zero component so the axis is never chosen as nearest.
 */
function boundaryDistance(coordinate, delta) {
  if (delta === 0) return Infinity;
  if (delta > 0) return (Math.floor(coordinate) + 1 - coordinate) / delta;
  return (coordinate - Math.floor(coordinate)) / -delta;
}

/**
 * Default target test: anything solid enough to look at. Liquids are skipped so
 * you can mine and build through water rather than clicking its surface.
 */
export function isTargetable(id, tables) {
  if (id === AIR) return false;
  return tables.render[id] !== Render.LIQUID;
}

/** Reused result object; `raycast` never allocates. */
const result = {
  hit: false,
  id: AIR,
  /** Block that was hit. */
  x: 0, y: 0, z: 0,
  /** Block adjacent to the hit face — where a placed block would go. */
  px: 0, py: 0, pz: 0,
  /** Face normal. */
  nx: 0, ny: 0, nz: 0,
  distance: 0,
};

/**
 * Cast a ray through the world.
 *
 * @param {import('../world/world.js').World} world
 * @param {{x:number,y:number,z:number}} origin
 * @param {{x:number,y:number,z:number}} direction  must be normalised
 * @param {number} maxDistance  in blocks
 * @param {(id:number, tables:object) => boolean} [test]
 * @returns {typeof result} the shared result object, valid until the next call
 */
export function raycast(world, origin, direction, maxDistance = 6, test = isTargetable) {
  const tables = world.tables;

  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = Math.sign(direction.x);
  const stepY = Math.sign(direction.y);
  const stepZ = Math.sign(direction.z);

  let tMaxX = boundaryDistance(origin.x, direction.x);
  let tMaxY = boundaryDistance(origin.y, direction.y);
  let tMaxZ = boundaryDistance(origin.z, direction.z);

  const tDeltaX = direction.x === 0 ? Infinity : Math.abs(1 / direction.x);
  const tDeltaY = direction.y === 0 ? Infinity : Math.abs(1 / direction.y);
  const tDeltaZ = direction.z === 0 ? Infinity : Math.abs(1 / direction.z);

  result.hit = false;
  result.nx = 0;
  result.ny = 0;
  result.nz = 0;
  result.distance = 0;

  // The ray starting inside a targetable block is a legitimate hit with no
  // face; callers treat a zero normal as "no placement position".
  const startId = world.getBlock(x, y, z);
  if (test(startId, tables)) {
    result.hit = true;
    result.id = startId;
    result.x = x; result.y = y; result.z = z;
    result.px = x; result.py = y; result.pz = z;
    return result;
  }

  let travelled = 0;
  // Bounded so a ray into unloaded sky cannot spin: each iteration advances at
  // least one block, and the loop also checks the distance directly.
  const maxSteps = Math.ceil(maxDistance * 3) + 3;

  for (let step = 0; step < maxSteps; step++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      travelled = tMaxX;
      if (travelled > maxDistance) break;
      x += stepX;
      tMaxX += tDeltaX;
      result.nx = -stepX; result.ny = 0; result.nz = 0;
    } else if (tMaxY < tMaxZ) {
      travelled = tMaxY;
      if (travelled > maxDistance) break;
      y += stepY;
      tMaxY += tDeltaY;
      result.nx = 0; result.ny = -stepY; result.nz = 0;
    } else {
      travelled = tMaxZ;
      if (travelled > maxDistance) break;
      z += stepZ;
      tMaxZ += tDeltaZ;
      result.nx = 0; result.ny = 0; result.nz = -stepZ;
    }

    const id = world.getBlock(x, y, z);
    if (!test(id, tables)) continue;

    result.hit = true;
    result.id = id;
    result.x = x; result.y = y; result.z = z;
    result.px = x + result.nx;
    result.py = y + result.ny;
    result.pz = z + result.nz;
    result.distance = travelled;
    return result;
  }

  return result;
}
