/**
 * Heads-up display: hotbar, vitals, screen effects and transient messages.
 *
 * The HUD is rebuilt only when something it shows actually changes. The hotbar
 * watches the inventory's version counter and the vitals compare against the
 * last values written, so the steady state costs a handful of number
 * comparisons per frame rather than a DOM write.
 */

import { el, clear } from './dom.js';
import { blockIcon } from './icons.js';
import { HOTBAR_SIZE } from '../game/inventory.js';
import { GameMode } from '../entity/player.js';
import { getBlock } from '../world/blocks.js';

const HEARTS = 10;
const BUBBLES = 10;

export class Hud {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root  the `#hud` container
   * @param {import('../game/inventory.js').Inventory} options.inventory
   */
  constructor({ root, inventory }) {
    this.root = root;
    this.inventory = inventory;

    this.hotbarVersion = -1;
    this.lastHealth = -1;
    this.lastBreath = -1;
    this.lastLabel = '';
    this.labelTimer = 0;

    this.build();
  }

  build() {
    clear(this.root);

    this.crosshair = el('div.crosshair');

    this.slots = [];
    this.counts = [];
    const slotNodes = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const count = el('span.slot__count');
      const icon = el('span.slot__icon');
      const slot = el('div.slot', { dataset: { index: String(i) } }, [
        icon,
        count,
        el('span.slot__key', { text: String(i + 1) }),
      ]);
      this.slots.push({ node: slot, icon });
      this.counts.push(count);
      slotNodes.push(slot);
    }
    this.hotbar = el('div.hotbar', {}, slotNodes);

    this.itemLabel = el('div.item-label');

    this.hearts = [];
    this.bubbles = [];
    const heartNodes = [];
    for (let i = 0; i < HEARTS; i++) {
      const node = el('span.pip.pip--heart');
      this.hearts.push(node);
      heartNodes.push(node);
    }
    const bubbleNodes = [];
    for (let i = 0; i < BUBBLES; i++) {
      const node = el('span.pip.pip--bubble');
      this.bubbles.push(node);
      bubbleNodes.push(node);
    }
    this.healthRow = el('div.vitals__row', {}, heartNodes);
    this.breathRow = el('div.vitals__row.vitals__row--breath', {}, bubbleNodes);
    this.vitals = el('div.vitals', {}, [this.breathRow, this.healthRow]);

    this.toasts = el('div.toasts');
    this.hint = el('div.hint');
    this.damage = el('div.overlay-effect.overlay-effect--damage');
    this.water = el('div.overlay-effect.overlay-effect--water');
    this.lava = el('div.overlay-effect.overlay-effect--lava');
    this.fps = el('div.fps-counter.hidden');
    this.debug = el('div.debug.hidden', { id: 'debug' });
    this.death = el('div.death-screen.hidden');

    this.root.append(
      this.water, this.lava, this.damage,
      this.crosshair, this.debug, this.fps, this.toasts,
      el('div.hud__bottom', {}, [this.itemLabel, this.vitals, this.hotbar]),
      this.hint, this.death,
    );
  }

  setVisible(visible) {
    this.root.classList.toggle('hidden', !visible);
  }

  /** Show a control hint that fades away on its own. */
  showHint(html, seconds = 9) {
    this.hint.innerHTML = html;
    this.hint.classList.remove('is-hidden');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.hint.classList.add('is-hidden'), seconds * 1000);
  }

  hideHint() {
    this.hint.classList.add('is-hidden');
  }

  /** Transient message in the top-centre stack. */
  toast(message, { seconds = 2.6, tone = '' } = {}) {
    const node = el(`div.toast${tone ? `.toast--${tone}` : ''}`, { text: message });
    this.toasts.append(node);
    // Force a reflow so the entry transition runs from the initial state.
    void node.offsetHeight;
    node.classList.add('is-in');
    setTimeout(() => {
      node.classList.remove('is-in');
      setTimeout(() => node.remove(), 320);
    }, seconds * 1000);
  }

  // -------------------------------------------------------------------------
  // Per-frame refresh
  // -------------------------------------------------------------------------

  /**
   * @param {number} delta
   * @param {object} state
   * @param {import('../entity/player.js').Player} state.player
   * @param {number} state.fps
   * @param {boolean} state.showFps
   */
  update(delta, { player, fps, showFps }) {
    this.refreshHotbar();
    this.refreshVitals(player);
    this.refreshEffects(player);

    if (this.labelTimer > 0) {
      this.labelTimer -= delta;
      if (this.labelTimer <= 0) this.itemLabel.classList.remove('is-visible');
    }

    this.fps.classList.toggle('hidden', !showFps);
    if (showFps) {
      const text = `${fps} fps`;
      if (this.fps.textContent !== text) this.fps.textContent = text;
    }
  }

  refreshHotbar() {
    const inventory = this.inventory;
    if (inventory.version === this.hotbarVersion) return;
    this.hotbarVersion = inventory.version;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const stack = inventory.slots[i];
      const { node, icon } = this.slots[i];
      node.classList.toggle('is-selected', i === inventory.selected);

      const id = stack?.id ?? 0;
      if (icon.dataset.block !== String(id)) {
        icon.dataset.block = String(id);
        clear(icon);
        if (id !== 0) icon.append(blockIcon(id, 40));
      }

      const count = stack && !inventory.infinite && stack.count > 1 ? String(stack.count) : '';
      if (this.counts[i].textContent !== count) this.counts[i].textContent = count;
    }

    const selected = inventory.selectedStack;
    this.setItemLabel(selected ? getBlock(selected.id).display : '');
  }

  setItemLabel(name) {
    if (name === this.lastLabel) return;
    this.lastLabel = name;
    if (!name) {
      this.itemLabel.classList.remove('is-visible');
      return;
    }
    this.itemLabel.textContent = name;
    this.itemLabel.classList.add('is-visible');
    this.labelTimer = 2;
  }

  refreshVitals(player) {
    const survival = player.gameMode === GameMode.SURVIVAL;
    this.vitals.classList.toggle('hidden', !survival);
    if (!survival) return;

    if (player.health !== this.lastHealth) {
      this.lastHealth = player.health;
      for (let i = 0; i < HEARTS; i++) {
        // Each pip is two hit points, so a 3 HP player shows one full and one
        // half heart rather than rounding away the odd point.
        const value = player.health - i * 2;
        this.hearts[i].dataset.state = value >= 2 ? 'full' : value >= 1 ? 'half' : 'empty';
      }
      this.healthRow.classList.toggle('is-critical', player.health <= 6);
    }

    const breathPips = Math.ceil((player.breath / 15) * BUBBLES);
    // Visibility is checked every frame, not just when the count changes:
    // going under with a full lungful changes nothing about the pips but very
    // much should show the row.
    this.breathRow.classList.toggle('hidden', !player.submerged && breathPips >= BUBBLES);
    if (breathPips !== this.lastBreath) {
      this.lastBreath = breathPips;
      for (let i = 0; i < BUBBLES; i++) {
        this.bubbles[i].dataset.state = i < breathPips ? 'full' : 'empty';
      }
    }
  }

  refreshEffects(player) {
    this.damage.style.opacity = String(Math.min(1, player.hurtFlash * 0.85));
    this.water.style.opacity = player.submerged ? '1' : '0';
    this.lava.style.opacity = player.inLava ? '1' : '0';
    this.death.classList.toggle('hidden', !player.dead);
  }

  /** Fill the death screen; the buttons are supplied by the caller. */
  setDeathContent(nodes) {
    clear(this.death);
    this.death.append(...[].concat(nodes));
  }
}
