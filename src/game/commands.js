/**
 * Chat commands.
 *
 * A sandbox lives or dies on being able to say "put me over there" or "make it
 * night" without hunting through menus, so the console is a first-class part of
 * the game rather than a debug afterthought.
 *
 * Each command declares its own usage string and the help listing is generated
 * from the table, so a command can never drift out of sync with its docs.
 */

import { GameMode } from '../entity/player.js';
import { getBlockByName, BLOCKS, AIR } from '../world/blocks.js';
import { DAY_LENGTH } from '../render/sky.js';

/**
 * @param {object} game  the running session, see game.js
 * @returns {{run: (input: string) => {text: string, tone: string}}}
 */
export function createCommands(game) {
  const ok = (text) => ({ text, tone: 'ok' });
  const fail = (text) => ({ text, tone: 'error' });

  const commands = {
    help: {
      usage: '/help',
      describe: 'List every command',
      run: () => ok(Object.entries(commands)
        .map(([name, command]) => `${command.usage} — ${command.describe}`)
        .join('\n')),
    },

    tp: {
      usage: '/tp <x> <y> <z>',
      describe: 'Teleport to a position',
      run: (args) => {
        if (args.length < 3) return fail('Usage: /tp <x> <y> <z>');
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => !Number.isFinite(n))) return fail('Coordinates must be numbers.');
        game.player.teleport(x, y, z);
        return ok(`Teleported to ${x}, ${y}, ${z}`);
      },
    },

    spawn: {
      usage: '/spawn',
      describe: 'Return to the world spawn point',
      run: () => {
        const spawn = game.player.spawnPoint;
        game.player.teleport(spawn.x, spawn.y, spawn.z);
        return ok('Returned to spawn.');
      },
    },

    setspawn: {
      usage: '/setspawn',
      describe: 'Set the spawn point to where you are standing',
      run: () => {
        game.player.spawnPoint.copy(game.player.position);
        return ok('Spawn point set.');
      },
    },

    gamemode: {
      usage: '/gamemode <survival|creative|spectator>',
      describe: 'Change game mode',
      run: (args) => {
        const aliases = {
          s: GameMode.SURVIVAL, survival: GameMode.SURVIVAL, 0: GameMode.SURVIVAL,
          c: GameMode.CREATIVE, creative: GameMode.CREATIVE, 1: GameMode.CREATIVE,
          sp: GameMode.SPECTATOR, spectator: GameMode.SPECTATOR, 3: GameMode.SPECTATOR,
        };
        const mode = aliases[(args[0] ?? '').toLowerCase()];
        if (!mode) return fail('Usage: /gamemode <survival|creative|spectator>');
        game.setGameMode(mode);
        return ok(`Game mode set to ${mode}.`);
      },
    },

    time: {
      usage: '/time <day|noon|night|midnight|freeze|0-1>',
      describe: 'Set or freeze the time of day',
      run: (args) => {
        const value = (args[0] ?? '').toLowerCase();
        const presets = { dawn: 0.25, day: 0.3, noon: 0.5, dusk: 0.75, night: 0.8, midnight: 0 };
        if (value === 'freeze' || value === 'stop') {
          game.sky.frozen = !game.sky.frozen;
          return ok(game.sky.frozen ? 'Time frozen.' : 'Time running.');
        }
        if (value in presets) {
          game.sky.setTime(presets[value]);
          return ok(`Time set to ${value}.`);
        }
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          game.sky.setTime(numeric > 1 ? numeric / 24000 : numeric);
          return ok(`Time set to ${game.sky.getClock()}.`);
        }
        return fail(`Unknown time "${value}".`);
      },
    },

    give: {
      usage: '/give <block> [count]',
      describe: 'Put blocks in your inventory',
      run: (args) => {
        if (args.length === 0) return fail('Usage: /give <block> [count]');
        const name = args[0].toLowerCase();
        const block = getBlockByName(name) ?? BLOCKS.find(
          (candidate) => candidate && candidate.id !== AIR
            && candidate.display.toLowerCase().replace(/\s+/g, '_') === name,
        );
        if (!block || block.id === AIR) return fail(`No block called "${args[0]}".`);
        const count = Math.max(1, Math.min(999, Number(args[1]) || 64));
        const leftover = game.inventory.add(block.id, count);
        return leftover > 0
          ? ok(`Gave ${count - leftover} ${block.display} (inventory full).`)
          : ok(`Gave ${count} ${block.display}.`);
      },
    },

    clear: {
      usage: '/clear',
      describe: 'Empty your inventory',
      run: () => {
        game.inventory.clear();
        return ok('Inventory cleared.');
      },
    },

    heal: {
      usage: '/heal',
      describe: 'Restore full health',
      run: () => {
        game.player.heal(game.player.maxHealth);
        return ok('Healed.');
      },
    },

    kill: {
      usage: '/kill',
      describe: 'Die, for testing respawn',
      run: () => {
        game.player.damage(999, 'command');
        return ok('Ouch.');
      },
    },

    seed: {
      usage: '/seed',
      describe: 'Show this world\'s seed',
      run: () => ok(`Seed: ${game.meta.seedText} (${game.world.seed})`),
    },

    where: {
      usage: '/where',
      describe: 'Show your position and biome',
      run: () => {
        const p = game.player.position;
        return ok(`${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} — ${game.currentBiomeName()}`);
      },
    },

    rd: {
      usage: '/rd <chunks>',
      describe: 'Set render distance',
      run: (args) => {
        const value = Math.max(2, Math.min(24, Math.round(Number(args[0]))));
        if (!Number.isFinite(value)) return fail('Usage: /rd <chunks>');
        game.settings.set('renderDistance', value);
        return ok(`Render distance set to ${value} chunks.`);
      },
    },

    daylength: {
      usage: '/daylength <seconds>',
      describe: `Real seconds per in-game day (default ${DAY_LENGTH})`,
      run: (args) => {
        const value = Math.max(0, Math.min(3600, Math.round(Number(args[0]))));
        if (!Number.isFinite(value)) return fail('Usage: /daylength <seconds>');
        game.settings.set('dayLength', value);
        return ok(value === 0 ? 'Time frozen.' : `A day now takes ${value} seconds.`);
      },
    },

    save: {
      usage: '/save',
      describe: 'Write the world to disk now',
      run: () => {
        game.save();
        return ok('Saved.');
      },
    },
  };

  return {
    commands,
    run(input) {
      const trimmed = input.trim();
      if (!trimmed.startsWith('/')) return { text: trimmed, tone: 'chat' };

      const [name, ...args] = trimmed.slice(1).split(/\s+/);
      const command = commands[name.toLowerCase()];
      if (!command) return fail(`Unknown command "/${name}". Try /help.`);

      try {
        return command.run(args);
      } catch (error) {
        console.error(error);
        return fail(`Command failed: ${error.message}`);
      }
    },
  };
}
