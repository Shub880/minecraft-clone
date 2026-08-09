/**
 * Inventory and creative block picker.
 *
 * One overlay serving two modes. Survival shows the player's storage grid and
 * hotbar; creative shows the full block palette with search and categories, and
 * treats the palette as an infinite source.
 *
 * Item movement is click-to-carry rather than HTML5 drag: a carried stack
 * follows the cursor and lands on the next slot clicked. It behaves identically
 * with a trackpad, survives a pointer leaving the window, and needs no drag
 * image, which the native API makes surprisingly hard to get right.
 */

import { el, clear } from './dom.js';
import { blockIcon } from './icons.js';
import { CREATIVE_GROUPS, getBlock, BLOCKS } from '../world/blocks.js';
import { HOTBAR_SIZE, STORAGE_SIZE, MAX_STACK } from '../game/inventory.js';
import { GameMode } from '../entity/player.js';

export class InventoryUI {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root
   * @param {import('../game/inventory.js').Inventory} options.inventory
   * @param {import('../entity/player.js').Player} options.player
   * @param {import('../core/audio.js').AudioEngine} options.audio
   */
  constructor({ root, inventory, player, audio }) {
    this.root = root;
    this.inventory = inventory;
    this.player = player;
    this.audio = audio;

    this.open = false;
    this.carried = null;
    this.category = 'All';
    this.search = '';
    this.onClose = null;

    this.cursor = el('div.carry.hidden');
    /**
     * Built fresh on every open rather than kept around and refilled. A node
     * that lives inside a `display: none` subtree does not reliably start its
     * entry animation when the subtree is revealed, which leaves the panel
     * sitting at the animation's opening keyframe — invisible. Creating the
     * element at the moment it is shown sidesteps that entirely.
     */
    this.panel = null;
    this.backdrop = el('div.modal__backdrop');
    this.root.append(this.backdrop, this.cursor);
    this.root.classList.add('modal');

    this.root.addEventListener('click', (event) => {
      // A click outside the panel closes; the panel stops its own clicks.
      if (event.target === this.root || event.target === this.backdrop) this.close();
    });

    // Pointer events rather than mouse events, so the carried stack follows a
    // finger as well as a cursor. `pointerdown` is included because a touch has
    // no hover: without it the icon would sit in the corner until the player
    // dragged, which reads as a bug.
    this._trackCursor = (event) => {
      if (!this.open) return;
      this.cursor.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
    };
    document.addEventListener('pointermove', this._trackCursor);
    document.addEventListener('pointerdown', this._trackCursor);
  }

  /** Detach from the document so a closed session leaves nothing behind. */
  dispose() {
    this.close();
    document.removeEventListener('pointermove', this._trackCursor);
    document.removeEventListener('pointerdown', this._trackCursor);
    clear(this.root);
    this.panel = null;
    this.backdrop = null;
    this.slotNodes = null;
    this.root.classList.add('hidden');
  }

  get isOpen() {
    return this.open;
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.open = true;
    this.root.classList.remove('hidden');
    this.render();
    this.audio?.ui('click');
  }

  close() {
    if (!this.open) return;
    this.open = false;
    // Anything still in hand goes back to the inventory rather than vanishing.
    if (this.carried) {
      this.inventory.add(this.carried.id, this.carried.count);
      this.setCarried(null);
    }
    this.root.classList.add('hidden');
    this.onClose?.();
  }

  setCarried(stack) {
    this.carried = stack;
    clear(this.cursor);
    if (!stack) {
      this.cursor.classList.add('hidden');
      return;
    }
    this.cursor.classList.remove('hidden');
    this.cursor.append(blockIcon(stack.id, 40));
    if (stack.count > 1) this.cursor.append(el('span.slot__count', { text: String(stack.count) }));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render() {
    const creative = this.player.gameMode === GameMode.CREATIVE;

    const previous = this.panel;
    this.panel = el('div.inv');
    this.slotNodes = new Map();

    this.panel.append(el('header.inv__head', {}, [
      el('h2.inv__title', { text: creative ? 'Blocks' : 'Inventory' }),
      creative ? this.buildSearch() : null,
      el('button.inv__close', { type: 'button', text: '✕', on: { click: () => this.close() } }),
    ]));

    if (creative) {
      this.panel.append(this.buildCategories());
      this.panel.append(this.buildPalette());
    } else {
      this.panel.append(el('div.inv__section-label', { text: 'Storage' }));
      this.panel.append(this.buildGrid(HOTBAR_SIZE, HOTBAR_SIZE + STORAGE_SIZE));
    }

    this.panel.append(el('div.inv__section-label', { text: 'Hotbar' }));
    this.panel.append(this.buildGrid(0, HOTBAR_SIZE, 'inv__grid--hotbar'));
    this.panel.append(el('p.inv__hint', {
      text: creative
        ? 'Click a block to pick it up, then click a hotbar slot to place it. Right-click a block to drop it straight into the selected slot.'
        : 'Click to pick up a stack, click again to place. Right-click splits a stack in half.',
    }));

    if (previous) previous.replaceWith(this.panel);
    else this.root.insertBefore(this.panel, this.cursor);
  }

  buildSearch() {
    return el('input.inv__search', {
      type: 'search',
      placeholder: 'Search blocks…',
      value: this.search,
      on: {
        input: (event) => {
          this.search = event.target.value.trim().toLowerCase();
          this.refreshPalette();
        },
        // The game listens for raw key codes; typing here must not move the
        // player or close the panel with `E`.
        keydown: (event) => event.stopPropagation(),
      },
    });
  }

  buildCategories() {
    const names = ['All', ...CREATIVE_GROUPS.map((group) => group.name)];
    return el('div.inv__tabs', {}, names.map((name) => el(
      `button.tab${name === this.category ? '.is-active' : ''}`,
      {
        type: 'button',
        text: name,
        on: {
          click: () => {
            this.category = name;
            this.render();
          },
        },
      },
    )));
  }

  /** Every block the current category and search allow, in registry order. */
  paletteIds() {
    const groups = this.category === 'All'
      ? CREATIVE_GROUPS
      : CREATIVE_GROUPS.filter((group) => group.name === this.category);

    const ids = [];
    for (const group of groups) {
      for (const id of group.blocks) {
        if (!this.search) {
          ids.push(id);
          continue;
        }
        const block = BLOCKS[id];
        if (block.display.toLowerCase().includes(this.search) || block.name.includes(this.search)) {
          ids.push(id);
        }
      }
    }
    return ids;
  }

  buildPalette() {
    this.palette = el('div.inv__grid.inv__grid--palette');
    this.refreshPalette();
    return this.palette;
  }

  refreshPalette() {
    if (!this.palette) return;
    clear(this.palette);
    const ids = this.paletteIds();
    if (ids.length === 0) {
      this.palette.append(el('p.inv__empty', { text: 'No blocks match that search.' }));
      return;
    }
    for (const id of ids) this.palette.append(this.buildPaletteSlot(id));
  }

  buildPaletteSlot(id) {
    const block = getBlock(id);
    const node = el('div.slot.slot--palette', { title: block.display }, [
      el('span.slot__icon', {}, [blockIcon(id, 40)]),
    ]);
    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (event.button === 2) {
        // Straight into the hand, the fast path for building.
        this.inventory.setSlot(this.inventory.selected, { id, count: 1 });
        this.audio?.ui('select');
        this.refreshSlots();
        return;
      }
      this.setCarried({ id, count: this.player.gameMode === GameMode.CREATIVE ? 1 : MAX_STACK });
      this.audio?.ui('click');
    });
    node.addEventListener('contextmenu', (event) => event.preventDefault());
    return node;
  }

  /** A grid of real inventory slots covering `[from, to)`. */
  buildGrid(from, to, extraClass = '') {
    const grid = el(`div.inv__grid${extraClass ? `.${extraClass}` : ''}`);
    for (let index = from; index < to; index++) {
      const node = this.buildSlot(index);
      this.slotNodes.set(index, node);
      grid.append(node);
    }
    return grid;
  }

  buildSlot(index) {
    const node = el('div.slot.slot--cell', { dataset: { index: String(index) } }, [
      el('span.slot__icon'),
      el('span.slot__count'),
    ]);
    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.handleSlotClick(index, event.button, event.shiftKey);
    });
    node.addEventListener('contextmenu', (event) => event.preventDefault());
    this.paintSlot(node, index);
    return node;
  }

  paintSlot(node, index) {
    const stack = this.inventory.slots[index];
    const icon = node.querySelector('.slot__icon');
    const count = node.querySelector('.slot__count');
    const id = stack?.id ?? 0;
    if (icon.dataset.block !== String(id)) {
      icon.dataset.block = String(id);
      clear(icon);
      if (id) icon.append(blockIcon(id, 40));
    }
    count.textContent = stack && stack.count > 1 ? String(stack.count) : '';
    node.classList.toggle('is-selected', index === this.inventory.selected && index < HOTBAR_SIZE);
    node.title = stack ? getBlock(stack.id).display : '';
  }

  refreshSlots() {
    if (!this.slotNodes) return;
    for (const [index, node] of this.slotNodes) this.paintSlot(node, index);
  }

  // -------------------------------------------------------------------------
  // Slot interaction
  // -------------------------------------------------------------------------

  handleSlotClick(index, button, shift) {
    const inventory = this.inventory;
    const slot = inventory.slots[index];

    // Shift-click shuttles a stack between the hotbar and storage.
    if (shift && slot && !this.carried) {
      const targetFrom = index < HOTBAR_SIZE ? HOTBAR_SIZE : 0;
      const targetTo = index < HOTBAR_SIZE ? HOTBAR_SIZE + STORAGE_SIZE : HOTBAR_SIZE;
      for (let i = targetFrom; i < targetTo; i++) {
        if (inventory.slots[i]) continue;
        inventory.swap(index, i);
        this.audio?.ui('click');
        this.refreshSlots();
        return;
      }
      return;
    }

    if (!this.carried) {
      if (!slot) return;
      if (button === 2 && slot.count > 1) {
        // Right-click takes half, leaving the remainder behind.
        const taken = Math.ceil(slot.count / 2);
        slot.count -= taken;
        inventory.touch();
        this.setCarried({ id: slot.id, count: taken });
      } else {
        this.setCarried({ ...slot });
        inventory.setSlot(index, null);
      }
      this.audio?.ui('click');
      this.refreshSlots();
      return;
    }

    // Placing what is carried.
    if (button === 2) {
      // Right-click drops a single item off the carried stack.
      if (slot && slot.id !== this.carried.id) return;
      if (slot && slot.count >= MAX_STACK) return;
      inventory.setSlot(index, { id: this.carried.id, count: (slot?.count ?? 0) + 1 });
      this.carried.count--;
      this.setCarried(this.carried.count > 0 ? this.carried : null);
    } else if (slot && slot.id === this.carried.id) {
      const moved = Math.min(MAX_STACK - slot.count, this.carried.count);
      inventory.setSlot(index, { id: slot.id, count: slot.count + moved });
      this.carried.count -= moved;
      this.setCarried(this.carried.count > 0 ? this.carried : null);
    } else {
      const previous = slot ? { ...slot } : null;
      inventory.setSlot(index, this.carried);
      this.setCarried(previous);
    }

    this.audio?.ui('click');
    this.refreshSlots();
  }
}
