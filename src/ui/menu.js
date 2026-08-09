/**
 * Menus: title, world list, world creation, settings, controls and pause.
 *
 * One component renders all of them, because they are the same thing in
 * different clothes — a panel of rows over a darkened backdrop — and because
 * the settings and controls screens have to be reachable from both the title
 * and the pause menu without existing twice.
 *
 * Screens are rebuilt on navigation rather than shown and hidden. They are
 * small, and rebuilding means a screen can never display stale data (a world's
 * last-played time, a rebound key) from the last time it was opened.
 */

import {
  el, clear, button, field, slider, toggle, choice, select, keyLabel, timeAgo, formatDuration,
} from './dom.js';
import { SETTING_SCHEMA } from '../core/settings.js';
import { DEFAULT_BINDINGS } from '../core/input.js';
import { WorldType } from '../world/worldgen/terrain.js';
import { GameMode } from '../entity/player.js';
import { makeWorldId } from '../core/storage.js';
import { parseSeed } from '../core/rng.js';

/** Option labels stay short so the select never truncates; the blurb goes in
 *  the field hint underneath, where there is room for a full sentence. */
const WORLD_TYPE_OPTIONS = [
  [WorldType.CONTINENTS, 'Continents'],
  [WorldType.ISLANDS, 'Islands'],
  [WorldType.AMPLIFIED, 'Amplified'],
  [WorldType.SUPERFLAT, 'Superflat'],
];

const WORLD_TYPE_HINTS = {
  [WorldType.CONTINENTS]: 'Balanced land and sea, with rivers and mountain ranges.',
  [WorldType.ISLANDS]: 'Land breaks into scattered archipelagos.',
  [WorldType.AMPLIFIED]: 'The same world with the mountains turned up.',
  [WorldType.SUPERFLAT]: 'A flat plain at sea level — a blank canvas.',
};

const GAME_MODE_OPTIONS = [
  [GameMode.SURVIVAL, 'Survival'],
  [GameMode.CREATIVE, 'Creative'],
];

const GAME_MODE_HINTS = {
  [GameMode.SURVIVAL]: 'Mine blocks to collect them. Falling, lava and drowning hurt.',
  [GameMode.CREATIVE]: 'Every block, unlimited, plus flight. Nothing can hurt you.',
};

/** Actions shown on the controls screen, in a sensible reading order. */
const BINDABLE = [
  ['forward', 'Walk Forward'],
  ['back', 'Walk Back'],
  ['left', 'Strafe Left'],
  ['right', 'Strafe Right'],
  ['jump', 'Jump / Fly Up'],
  ['sneak', 'Sneak / Fly Down'],
  ['sprint', 'Sprint'],
  ['inventory', 'Inventory'],
  ['drop', 'Drop Item'],
  ['chat', 'Chat'],
  ['command', 'Command'],
  ['perspective', 'Change View'],
  ['debug', 'Debug Overlay'],
  ['screenshot', 'Screenshot'],
  ['fullscreen', 'Fullscreen'],
  ['pause', 'Pause'],
];

export class Menu {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root
   * @param {import('../core/settings.js').Settings} options.settings
   * @param {import('../core/storage.js').WorldStore} options.store
   * @param {import('../core/audio.js').AudioEngine} options.audio
   */
  constructor({ root, settings, store, audio }) {
    this.root = root;
    this.settings = settings;
    this.store = store;
    this.audio = audio;

    /** 'title' while no world is loaded, 'pause' while one is. */
    this.mode = 'title';
    this.screen = 'title';
    this.rebinding = null;

    this.content = el('div.menu__content');
    this.root.append(el('div.menu__backdrop'), this.content);

    /** @type {(meta: object) => void} */
    this.onPlay = null;
    this.onResume = null;
    this.onQuit = null;

    document.addEventListener('keydown', (event) => this.handleRebindKey(event), true);
    document.addEventListener('keydown', (event) => this.handleEscape(event));
  }

  /**
   * Escape backs out one screen, and closes the pause menu from its top level.
   *
   * Handled here rather than in the game loop because only the menu knows
   * whether the player is looking at the pause screen or three levels into
   * settings, and backing out of settings should not un-pause the world.
   */
  handleEscape(event) {
    if (!this.isOpen || this.rebinding || event.key !== 'Escape') return;
    event.preventDefault();
    if (this.screen !== this.home) {
      this.nav(this.home);
      return;
    }
    if (this.mode !== 'pause') return;
    this.audio?.ui('click');
    this.close();
    this.onResume?.();
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  openTitle() {
    this.mode = 'title';
    this.root.classList.remove('hidden');
    this.root.classList.remove('menu--pause');
    this.show('title');
  }

  openPause() {
    this.mode = 'pause';
    this.root.classList.remove('hidden');
    this.root.classList.add('menu--pause');
    this.show('pause');
  }

  close() {
    this.root.classList.add('hidden');
    this.rebinding = null;
  }

  show(screen) {
    this.screen = screen;
    clear(this.content);
    const builders = {
      title: () => this.buildTitle(),
      pause: () => this.buildPause(),
      worlds: () => this.buildWorlds(),
      create: () => this.buildCreate(),
      settings: () => this.buildSettings(),
      controls: () => this.buildControls(),
      help: () => this.buildHelp(),
    };
    this.content.append((builders[screen] ?? builders.title)());
  }

  /** Where "Back" goes from a shared screen. */
  get home() {
    return this.mode === 'pause' ? 'pause' : 'title';
  }

  nav(screen) {
    this.audio?.ui('click');
    this.show(screen);
  }

  panel(title, subtitle, children, { back = null, wide = false } = {}) {
    return el(`div.panel${wide ? '.panel--wide' : ''}`, {}, [
      el('header.panel__head', {}, [
        el('h2.panel__title', { text: title }),
        subtitle ? el('p.panel__subtitle', { text: subtitle }) : null,
      ]),
      el('div.panel__body', {}, children),
      back ? el('div.panel__foot', {}, [button('Back', () => this.nav(back))]) : null,
    ]);
  }

  // -------------------------------------------------------------------------
  // Title and pause
  // -------------------------------------------------------------------------

  buildTitle() {
    return el('div.panel.panel--title', {}, [
      el('div.brand', {}, [
        el('h1.brand__name', { text: 'VOXEL' }),
        el('p.brand__tag', { text: 'An infinite procedural block world' }),
      ]),
      el('div.menu__actions', {}, [
        button('Play', () => this.nav('worlds'), { variant: 'primary' }),
        button('Settings', () => this.nav('settings')),
        button('Controls', () => this.nav('controls')),
        button('How to Play', () => this.nav('help')),
      ]),
      el('p.menu__footer', {
        text: this.store.isPersistent
          ? 'Worlds are saved in this browser.'
          : 'Storage unavailable — worlds will not persist after a reload.',
      }),
    ]);
  }

  buildPause() {
    return el('div.panel.panel--pause', {}, [
      el('h2.panel__title', { text: 'Paused' }),
      el('div.menu__actions', {}, [
        button('Resume', () => {
          this.audio?.ui('click');
          this.close();
          this.onResume?.();
        }, { variant: 'primary' }),
        button('Settings', () => this.nav('settings')),
        button('Controls', () => this.nav('controls')),
        button('How to Play', () => this.nav('help')),
        button('Save and Quit', () => {
          this.audio?.ui('click');
          this.onQuit?.();
        }, { variant: 'danger' }),
      ]),
    ]);
  }

  // -------------------------------------------------------------------------
  // Worlds
  // -------------------------------------------------------------------------

  buildWorlds() {
    const list = el('div.worlds', {}, [el('p.worlds__empty', { text: 'Loading saves…' })]);

    this.store.listWorlds().then((worlds) => {
      clear(list);
      if (worlds.length === 0) {
        list.append(el('p.worlds__empty', {
          text: 'No worlds yet. Create one to get started.',
        }));
        return;
      }
      for (const world of worlds) list.append(this.buildWorldRow(world));
    }).catch((error) => {
      clear(list);
      list.append(el('p.worlds__empty', { text: `Could not read saves: ${error.message}` }));
    });

    return this.panel('Your Worlds', null, [
      list,
      el('div.panel__actions', {}, [
        button('Create New World', () => this.nav('create'), { variant: 'primary' }),
      ]),
    ], { back: this.home, wide: true });
  }

  buildWorldRow(world) {
    const meta = [
      world.gameMode === GameMode.CREATIVE ? 'Creative' : 'Survival',
      WORLD_TYPE_OPTIONS.find(([value]) => value === world.worldType)?.[1] ?? 'Continents',
      `seed ${world.seedText}`,
      formatDuration(world.playTime ?? 0),
    ].join(' · ');

    const row = el('div.world', {}, [
      el('div.world__info', {}, [
        el('h3.world__name', { text: world.name }),
        el('p.world__meta', { text: meta }),
        el('p.world__time', { text: `Last played ${timeAgo(world.updated)}` }),
      ]),
      el('div.world__actions', {}, [
        button('Play', () => {
          this.audio?.ui('click');
          this.onPlay?.(world);
        }, { variant: 'primary' }),
        button('Delete', () => this.confirmDelete(world, row), { variant: 'ghost' }),
      ]),
    ]);
    return row;
  }

  confirmDelete(world, row) {
    const confirmRow = el('div.world.world--confirm', {}, [
      el('p.world__name', { text: `Delete "${world.name}" permanently?` }),
      el('div.world__actions', {}, [
        button('Delete', async () => {
          await this.store.deleteWorld(world.id);
          confirmRow.remove();
        }, { variant: 'danger' }),
        button('Cancel', () => {
          confirmRow.replaceWith(row);
        }),
      ]),
    ]);
    row.replaceWith(confirmRow);
  }

  // -------------------------------------------------------------------------
  // World creation
  // -------------------------------------------------------------------------

  buildCreate() {
    const draft = {
      name: suggestName(),
      seedText: '',
      worldType: WorldType.CONTINENTS,
      gameMode: GameMode.SURVIVAL,
      caveDensity: 1,
      treeDensity: 1,
    };

    const nameInput = el('input.input', {
      type: 'text',
      value: draft.name,
      maxlength: '40',
      on: { input: (event) => { draft.name = event.target.value; } },
    });

    const seedInput = el('input.input', {
      type: 'text',
      placeholder: 'Leave blank for a random seed',
      on: { input: (event) => { draft.seedText = event.target.value; } },
    });

    // The hints update as the selection changes, so the short option label in
    // the dropdown always has its explanation right underneath.
    const typeHint = el('span.field__hint', { text: WORLD_TYPE_HINTS[draft.worldType] });
    const modeHint = el('span.field__hint', { text: GAME_MODE_HINTS[draft.gameMode] });

    return this.panel('Create a World', 'Everything is generated from the seed — the same seed always makes the same world.', [
      field('World Name', nameInput),
      field('Seed', seedInput, 'Numbers are used directly; anything else is hashed.'),
      el('label.field', {}, [
        el('span.field__label', { text: 'World Type' }),
        select({
          options: WORLD_TYPE_OPTIONS,
          value: draft.worldType,
          onChange: (value) => {
            draft.worldType = value;
            typeHint.textContent = WORLD_TYPE_HINTS[value];
          },
        }),
        typeHint,
      ]),
      el('label.field', {}, [
        el('span.field__label', { text: 'Game Mode' }),
        select({
          options: GAME_MODE_OPTIONS,
          value: draft.gameMode,
          onChange: (value) => {
            draft.gameMode = value;
            modeHint.textContent = GAME_MODE_HINTS[value];
          },
        }),
        modeHint,
      ]),
      field('Cave Density', slider({
        min: 0, max: 2, step: 0.1, value: draft.caveDensity,
        format: (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`),
        onInput: (value) => { draft.caveDensity = value; },
      })),
      field('Tree Density', slider({
        min: 0, max: 2, step: 0.1, value: draft.treeDensity,
        format: (v) => (v === 0 ? 'None' : `${Math.round(v * 100)}%`),
        onInput: (value) => { draft.treeDensity = value; },
      })),
      el('div.panel__actions', {}, [
        button('Create World', () => {
          const seedText = draft.seedText.trim() || String(Math.floor(Math.random() * 1e9));
          this.audio?.ui('click');
          this.onPlay?.({
            id: makeWorldId(),
            name: draft.name.trim() || 'New World',
            seedText,
            seed: parseSeed(seedText),
            worldType: draft.worldType,
            gameMode: draft.gameMode,
            caveDensity: draft.caveDensity,
            treeDensity: draft.treeDensity,
            created: Date.now(),
            updated: Date.now(),
            playTime: 0,
          });
        }, { variant: 'primary' }),
      ]),
    ], { back: 'worlds' });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  buildSettings() {
    const groups = SETTING_SCHEMA.map((group) => el('section.settings__group', {}, [
      el('h3.settings__heading', { text: group.group }),
      ...group.items.map((item) => this.buildSettingRow(item)),
    ]));

    return this.panel('Settings', null, [
      ...groups,
      el('div.panel__actions', {}, [
        button('Reset to Defaults', () => {
          this.settings.reset();
          this.show('settings');
        }, { variant: 'ghost' }),
      ]),
    ], { back: this.home, wide: true });
  }

  buildSettingRow(item) {
    const value = this.settings.get(item.key);
    const control = this.buildSettingControl(item, value);
    return field(item.label, control, item.hint);
  }

  buildSettingControl(item, value) {
    if (item.type === 'toggle') {
      return toggle({ value, onChange: (next) => this.settings.set(item.key, next) });
    }
    if (item.type === 'choice') {
      return choice({
        options: item.options,
        value,
        onChange: (next) => this.settings.set(item.key, next),
      });
    }
    return slider({
      min: item.min,
      max: item.max,
      step: item.step,
      value,
      format: item.format,
      onInput: (next) => this.settings.set(item.key, next),
    });
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  buildControls() {
    this.rebinding = null;
    const rows = BINDABLE.map(([action, label]) => {
      const codes = this.settings.bindings[action] ?? DEFAULT_BINDINGS[action] ?? [];
      const keyButton = el('button.keybind', {
        type: 'button',
        text: codes.map(keyLabel).join(' / ') || '—',
        on: {
          click: () => {
            this.rebinding = { action, node: keyButton };
            keyButton.textContent = 'Press a key…';
            keyButton.classList.add('is-listening');
          },
        },
      });
      return el('div.keyrow', {}, [el('span.keyrow__label', { text: label }), keyButton]);
    });

    return this.panel('Controls', 'Click a binding, then press the key you want.', [
      el('div.keygrid', {}, rows),
      el('div.panel__actions', {}, [
        button('Reset to Defaults', () => {
          this.settings.resetBindings();
          this.show('controls');
        }, { variant: 'ghost' }),
      ]),
      el('p.panel__note', {
        text: 'Mouse: left click mines, right click places, middle click picks the block you are looking at, scroll changes the hotbar slot.',
      }),
    ], { back: this.home, wide: true });
  }

  /** Captured on the document so it beats the game's own key handling. */
  handleRebindKey(event) {
    if (!this.rebinding) return;
    event.preventDefault();
    event.stopPropagation();

    const { action, node } = this.rebinding;
    this.rebinding = null;
    node.classList.remove('is-listening');

    if (event.code === 'Escape') {
      node.textContent = (this.settings.bindings[action] ?? []).map(keyLabel).join(' / ') || '—';
      return;
    }

    this.settings.rebind(action, event.code);
    node.textContent = keyLabel(event.code);
    this.audio?.ui('select');
  }

  // -------------------------------------------------------------------------
  // Help
  // -------------------------------------------------------------------------

  buildHelp() {
    if (document.documentElement.classList.contains('is-mobile')) return this.buildTouchHelp();

    const rows = [
      ['Move', 'W A S D, and Space to jump'],
      ['Sprint', 'Hold Ctrl while moving forward'],
      ['Sneak', 'Hold Shift — you will not walk off an edge'],
      ['Fly', 'Creative only: double-tap Space, then Space and Shift for up and down'],
      ['Mine', 'Hold left mouse. Harder blocks take longer'],
      ['Place', 'Right mouse. Blocks cannot be placed inside you'],
      ['Pick block', 'Middle mouse copies the block you are looking at'],
      ['Hotbar', 'Scroll wheel, or the number keys 1–9'],
      ['Inventory', 'E — in creative this is the full block palette, with search'],
      ['Commands', 'Press / for things like /tp, /time day, /gamemode creative'],
      ['Screenshot', 'F2 saves a PNG'],
    ];

    return this.panel('How to Play', 'Build anything. The world goes on forever in every direction.', [
      el('dl.helplist', {}, rows.flatMap(([term, description]) => [
        el('dt', { text: term }),
        el('dd', { text: description }),
      ])),
      el('p.panel__note', {
        text: 'Survival: mine blocks to collect them, watch your health, and do not fall too far. '
          + 'Creative: unlimited blocks and flight, with damage switched off.',
      }),
    ], { back: this.home, wide: true });
  }

  /** The same screen, describing the gestures instead of the keys. */
  buildTouchHelp() {
    const rows = [
      ['Move', 'Drag the stick on the left. Push it all the way to sprint'],
      ['Turn', 'Push the stick sideways — you turn to face the way you are going'],
      ['Look', 'Drag anywhere the stick and the buttons are not. While a finger '
        + 'is down the stick sidesteps instead of turning'],
      ['Mine', 'Press and hold on the block you are aiming at'],
      ['Place', 'Tap once — aim with the crosshair first'],
      ['Jump', 'The big button on the right'],
      ['Sneak', 'Hold the down button — you will not walk off an edge'],
      ['Fly', 'Creative only: the wing button toggles it, then jump and sneak for up and down'],
      ['Hotbar', 'Tap a slot at the bottom of the screen'],
      ['More', 'The dotted button in the corner opens inventory, chat, view, '
        + 'fullscreen and the menu'],
    ];

    return this.panel('How to Play', 'Build anything. The world goes on forever in every direction.', [
      el('dl.helplist', {}, rows.flatMap(([term, description]) => [
        el('dt', { text: term }),
        el('dd', { text: description }),
      ])),
      el('p.panel__note', {
        text: 'Settings → Mobile has the look speed, a left-handed layout, and a switch for '
          + 'turning with the stick. Mobile mode itself can be switched off if you would '
          + 'rather use a keyboard.',
      }),
    ], { back: this.home, wide: true });
  }
}

/** A pleasant default name, so the create screen is never blank. */
function suggestName() {
  const adjectives = ['Quiet', 'Golden', 'Distant', 'Hidden', 'Wandering', 'Amber', 'Northern', 'Verdant'];
  const nouns = ['Valley', 'Expanse', 'Hollow', 'Reach', 'Basin', 'Frontier', 'Meadow', 'Coast'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(adjectives)} ${pick(nouns)}`;
}
