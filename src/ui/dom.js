/**
 * Minimal DOM helpers.
 *
 * The interface is built in JavaScript rather than written out in HTML because
 * almost all of it is a list of something — settings rows, world saves, key
 * bindings, inventory slots. Hand-writing those in markup means keeping two
 * copies of the same structure in sync.
 */

/**
 * Create an element.
 *
 * @param {string} tag  optionally with classes: `div.panel.is-open`
 * @param {object} [props]  attributes, `style` object, `on` event map, `text`
 * @param {(Node|string)[]} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = `${node.className} ${value}`.trim();
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key in node && key !== 'list') {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** A styled button with a click handler. */
export function button(label, onClick, { variant = '', disabled = false } = {}) {
  return el(`button.btn${variant ? `.btn--${variant}` : ''}`, {
    type: 'button',
    text: label,
    disabled,
    on: { click: onClick },
  });
}

/** A labelled row wrapping any control. */
export function field(label, control, hint) {
  return el('label.field', {}, [
    el('span.field__label', { text: label }),
    control,
    hint ? el('span.field__hint', { text: hint }) : null,
  ]);
}

/** A slider bound to a getter/setter pair, with a live value readout. */
export function slider({ min, max, step, value, format, onInput }) {
  const readout = el('span.slider__value', { text: format ? format(value) : String(value) });
  const input = el('input.slider__input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    on: {
      input: (event) => {
        const next = Number(event.target.value);
        readout.textContent = format ? format(next) : String(next);
        onInput(next);
      },
    },
  });
  return el('div.slider', {}, [input, readout]);
}

/** An on/off switch. */
export function toggle({ value, onChange }) {
  const node = el('button.toggle', {
    type: 'button',
    'aria-pressed': String(Boolean(value)),
    on: {
      click: () => {
        const next = node.getAttribute('aria-pressed') !== 'true';
        node.setAttribute('aria-pressed', String(next));
        node.classList.toggle('is-on', next);
        onChange(next);
      },
    },
  }, [el('span.toggle__knob')]);
  node.classList.toggle('is-on', Boolean(value));
  return node;
}

/**
 * A segmented control built from `[value, label]` pairs.
 *
 * Preferred over a `<select>` for short option lists because every choice is
 * visible and one tap wide — a native picker on a phone covers the screen with
 * a wheel to choose between three words.
 */
export function choice({ options, value, onChange }) {
  const buttons = [];
  const group = el('div.choice');

  for (const [optionValue, label] of options) {
    const node = el('button.choice__option', {
      type: 'button',
      text: label,
      'aria-pressed': String(optionValue === value),
      on: {
        click: () => {
          for (const other of buttons) {
            other.setAttribute('aria-pressed', String(other === node));
          }
          onChange(optionValue);
        },
      },
    });
    buttons.push(node);
    group.append(node);
  }

  return group;
}

/** A native select built from `[value, label]` pairs. */
export function select({ options, value, onChange }) {
  return el('select.select', {
    on: { change: (event) => onChange(event.target.value) },
  }, options.map(([optionValue, label]) => el('option', {
    value: optionValue,
    text: label,
    selected: optionValue === value,
  })));
}

/** Human-readable label for a `KeyboardEvent.code`. */
export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const named = {
    ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    Space: 'Space', Escape: 'Esc', Slash: '/', Backquote: '`',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Minus: '-', Equal: '=', Backslash: '\\',
    Tab: 'Tab', CapsLock: 'Caps', Enter: 'Enter', Backspace: 'Backspace',
  };
  return named[code] ?? code;
}

/** "3 minutes ago" style formatting for the world list. */
export function timeAgo(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** `1h 04m` style play-time formatting. */
export function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}
