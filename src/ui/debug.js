/**
 * F3 debug overlay.
 *
 * Refreshed on a timer rather than every frame: the text changes faster than
 * anyone can read it, and formatting a dozen numbers into innerHTML every
 * frame is a measurable cost at high frame rates.
 */

import { SEA_LEVEL, toChunkCoord, toLocalCoord } from '../world/constants.js';
import { getBiome } from '../world/worldgen/biomes.js';
import { getBlock } from '../world/blocks.js';
import { GameMode } from '../entity/player.js';

/** Compass letter from a yaw angle, matching the -Z = north convention. */
function facing(yaw) {
  const degrees = ((-yaw * 180) / Math.PI + 360) % 360;
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(degrees / 45) % 8];
}

export class DebugOverlay {
  constructor(node) {
    this.node = node;
    this.visible = false;
    this.timer = 0;
  }

  toggle() {
    this.visible = !this.visible;
    this.node.classList.toggle('hidden', !this.visible);
    return this.visible;
  }

  setVisible(visible) {
    this.visible = visible;
    this.node.classList.toggle('hidden', !visible);
  }

  update(delta, state) {
    if (!this.visible) return;
    this.timer += delta;
    if (this.timer < 0.2) return;
    this.timer = 0;
    this.node.innerHTML = this.render(state);
  }

  render({ engine, world, sky, player, atlas, meta }) {
    const p = player.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    const cx = toChunkCoord(bx);
    const cz = toChunkCoord(bz);

    const chunk = world.getChunk(cx, cz);
    const biomeId = chunk ? chunk.getBiome(toLocalCoord(bx), toLocalCoord(bz)) : 4;
    const standingOn = getBlock(world.getBlock(bx, by - 1, bz));

    const sky15 = world.getSkyLight(bx, by, bz);
    const block15 = world.getBlockLight(bx, by, bz);

    const memory = performance.memory
      ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB heap`
      : '';

    return [
      `<b>${engine.fps} fps</b>   ${engine.frameTime.toFixed(1)} ms   ${engine.drawCalls} draws   ${(engine.triangles / 1000).toFixed(0)}k tris`,
      '',
      `xyz    ${p.x.toFixed(2)}  ${p.y.toFixed(2)}  ${p.z.toFixed(2)}`,
      `block  ${bx}  ${by}  ${bz}`,
      `chunk  ${cx}, ${cz}   local ${toLocalCoord(bx)}, ${toLocalCoord(bz)}`,
      `facing ${facing(player.yaw)}   pitch ${(player.pitch * 57.3).toFixed(0)}°`,
      '',
      `biome  <b>${getBiome(biomeId).display}</b>`,
      `on     ${standingOn.display}`,
      `light  sky ${sky15}   block ${block15}`,
      `sea    ${SEA_LEVEL}`,
      '',
      `mode   ${player.gameMode}${player.flying ? ' (flying)' : ''}`,
      `state  ${player.onGround ? 'grounded' : 'airborne'}${player.inWater ? ' · in water' : ''}${player.inLava ? ' · in lava' : ''}`,
      player.gameMode === GameMode.SURVIVAL ? `health ${player.health}/${player.maxHealth}   fall ${player.fallDistance.toFixed(1)}` : '',
      '',
      `time   ${sky.getClock()}${sky.frozen ? ' (frozen)' : ''}`,
      `chunks ${world.stats.chunksLoaded} loaded · ${world.stats.pending} pending`,
      `atlas  ${atlas.layers} layers   seed ${meta.seedText}`,
      memory,
      '',
      'F3 debug · F5 view · F2 screenshot · T chat',
    ].filter((line) => line !== '').join('\n');
  }
}
