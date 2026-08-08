/**
 * Chat and command console.
 *
 * Two states from one log: closed, where recent lines fade out over the world,
 * and open, where the full scrollback is visible and the input takes keys.
 *
 * While open, keyboard events are stopped before they reach the game's global
 * listener. Without that, typing `/tp` would also toggle whatever `t` and `p`
 * happen to be bound to.
 */

import { el, clear } from './dom.js';

const MAX_HISTORY = 120;
const FADE_SECONDS = 9;

export class Chat {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root
   * @param {(text: string) => {text: string, tone: string}} options.onSubmit
   */
  constructor({ root, onSubmit, audio }) {
    this.root = root;
    this.onSubmit = onSubmit;
    this.audio = audio;
    this.open = false;
    /** Previously submitted lines, newest last, for arrow-key recall. */
    this.history = [];
    this.historyIndex = -1;
    this.onClose = null;

    this.log = el('div.chat__log');
    this.input = el('input.chat__input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: 'Message or /command',
    });

    this.inputRow = el('div.chat__row.hidden', {}, [this.input]);
    this.root.append(this.log, this.inputRow);
    this.root.classList.add('chat');

    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        this.submit();
      } else if (event.key === 'Escape') {
        this.close();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.recall(-1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.recall(1);
      }
    });
    this.input.addEventListener('keyup', (event) => event.stopPropagation());
  }

  get isOpen() {
    return this.open;
  }

  show(prefill = '') {
    this.open = true;
    this.root.classList.add('is-open');
    this.inputRow.classList.remove('hidden');
    this.input.value = prefill;
    this.historyIndex = this.history.length;
    // Focus after the class change so the browser does not scroll the page.
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('is-open');
    this.inputRow.classList.add('hidden');
    this.input.blur();
    this.input.value = '';
    this.onClose?.();
  }

  submit() {
    const value = this.input.value.trim();
    this.close();
    if (!value) return;

    this.history.push(value);
    if (this.history.length > 40) this.history.shift();

    const result = this.onSubmit(value);
    if (result?.text) this.print(result.text, result.tone);
  }

  recall(direction) {
    if (this.history.length === 0) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.input.value = this.history[this.historyIndex] ?? '';
    // Put the caret at the end rather than wherever it happened to be.
    requestAnimationFrame(() => this.input.setSelectionRange(9999, 9999));
  }

  /** Append a line. Multi-line text becomes one entry per line. */
  print(text, tone = 'chat') {
    for (const line of String(text).split('\n')) {
      const node = el(`div.chat__line.chat__line--${tone}`, { text: line });
      node.dataset.born = String(performance.now());
      this.log.append(node);
    }
    while (this.log.childElementCount > MAX_HISTORY) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Fade old lines out while the console is closed. */
  update() {
    if (this.open) {
      for (const node of this.log.children) node.style.opacity = '1';
      return;
    }
    const now = performance.now();
    for (const node of this.log.children) {
      const age = (now - Number(node.dataset.born)) / 1000;
      node.style.opacity = age > FADE_SECONDS ? '0' : age > FADE_SECONDS - 1.5 ? String(1 - (age - (FADE_SECONDS - 1.5)) / 1.5) : '1';
    }
  }

  clearLog() {
    clear(this.log);
  }

  dispose() {
    this.close();
    clear(this.root);
    this.root.classList.remove('is-open');
  }
}
