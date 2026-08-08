/**
 * Player inventory.
 *
 * A flat array of slots: the first nine are the hotbar, the rest are storage.
 * One array rather than two means the inventory screen can move a stack between
 * hotbar and storage by swapping two indices, with no special cases at the
 * boundary.
 *
 * Creative mode uses the same structure but never decrements a stack, so the
 * placement code does not need to branch on game mode — it calls `consume` and
 * the inventory decides whether that costs anything.
 */

export const HOTBAR_SIZE = 9;
export const STORAGE_ROWS = 3;
export const STORAGE_SIZE = HOTBAR_SIZE * STORAGE_ROWS;
export const TOTAL_SLOTS = HOTBAR_SIZE + STORAGE_SIZE;
export const MAX_STACK = 64;

export class Inventory {
  constructor() {
    /** @type {({id:number, count:number}|null)[]} */
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    this.selected = 0;
    this.infinite = false;
    /** Bumped on any change, so the HUD can skip redrawing an unchanged bar. */
    this.version = 0;
    this.onChange = null;
  }

  touch() {
    this.version++;
    this.onChange?.(this);
  }

  get selectedStack() {
    return this.slots[this.selected];
  }

  get selectedId() {
    return this.slots[this.selected]?.id ?? 0;
  }

  select(index) {
    const next = ((index % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (next === this.selected) return;
    this.selected = next;
    this.touch();
  }

  cycle(delta) {
    this.select(this.selected + delta);
  }

  /**
   * Add items, filling partial stacks before empty slots.
   * Returns however many did not fit.
   */
  add(id, count = 1) {
    if (id === 0 || count <= 0) return 0;
    if (this.infinite) {
      // Creative picking replaces the held slot rather than accumulating.
      this.setSlot(this.selected, { id, count: 1 });
      return 0;
    }

    let remaining = count;

    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      const slot = this.slots[i];
      if (!slot || slot.id !== id || slot.count >= MAX_STACK) continue;
      const room = MAX_STACK - slot.count;
      const moved = Math.min(room, remaining);
      slot.count += moved;
      remaining -= moved;
    }

    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const moved = Math.min(MAX_STACK, remaining);
      this.slots[i] = { id, count: moved };
      remaining -= moved;
    }

    if (remaining !== count) this.touch();
    return remaining;
  }

  /** True if the inventory has room for at least one of `id`. */
  hasRoomFor(id) {
    if (this.infinite) return true;
    for (const slot of this.slots) {
      if (!slot) return true;
      if (slot.id === id && slot.count < MAX_STACK) return true;
    }
    return false;
  }

  /**
   * Spend one of the selected stack. Returns the block id that was spent, or 0
   * if the slot was empty. Creative never actually decrements.
   */
  consumeSelected() {
    const slot = this.slots[this.selected];
    if (!slot) return 0;
    if (this.infinite) return slot.id;

    const id = slot.id;
    slot.count--;
    if (slot.count <= 0) this.slots[this.selected] = null;
    this.touch();
    return id;
  }

  /** Drop the whole selected stack (or one item). Returns what was removed. */
  dropSelected(whole = false) {
    const slot = this.slots[this.selected];
    if (!slot) return null;
    if (this.infinite) {
      this.slots[this.selected] = null;
      this.touch();
      return { id: slot.id, count: 1 };
    }
    const count = whole ? slot.count : 1;
    slot.count -= count;
    if (slot.count <= 0) this.slots[this.selected] = null;
    this.touch();
    return { id: slot.id, count };
  }

  setSlot(index, stack) {
    if (index < 0 || index >= TOTAL_SLOTS) return;
    this.slots[index] = stack && stack.count > 0 ? { ...stack } : null;
    this.touch();
  }

  swap(a, b) {
    if (a === b || a < 0 || b < 0 || a >= TOTAL_SLOTS || b >= TOTAL_SLOTS) return;
    const first = this.slots[a];
    const second = this.slots[b];

    // Merging identical stacks is what players expect from a drag onto a
    // matching slot, and it avoids a pointless swap animation.
    if (first && second && first.id === second.id && second.count < MAX_STACK) {
      const moved = Math.min(first.count, MAX_STACK - second.count);
      second.count += moved;
      first.count -= moved;
      if (first.count <= 0) this.slots[a] = null;
      this.touch();
      return;
    }

    this.slots[a] = second;
    this.slots[b] = first;
    this.touch();
  }

  /**
   * Put a block in the hand, the way middle-click does: reuse an existing slot
   * if the player already has it, otherwise overwrite the selected one.
   */
  pick(id) {
    if (id === 0) return;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (this.slots[i]?.id === id) {
        this.select(i);
        return;
      }
    }
    if (!this.infinite) {
      for (let i = HOTBAR_SIZE; i < TOTAL_SLOTS; i++) {
        if (this.slots[i]?.id !== id) continue;
        this.swap(i, this.selected);
        return;
      }
      // Survival cannot conjure a block it does not have.
      return;
    }
    this.setSlot(this.selected, { id, count: 1 });
  }

  /** Index of the first empty slot, or -1. */
  firstEmpty() {
    return this.slots.findIndex((slot) => slot === null);
  }

  clear() {
    this.slots.fill(null);
    this.touch();
  }

  /** Preload the hotbar so a new creative world starts with useful blocks. */
  fill(ids) {
    ids.forEach((id, index) => {
      if (index < TOTAL_SLOTS) this.slots[index] = id ? { id, count: this.infinite ? 1 : MAX_STACK } : null;
    });
    this.touch();
  }

  serialize() {
    return {
      selected: this.selected,
      slots: this.slots.map((slot) => (slot ? [slot.id, slot.count] : null)),
    };
  }

  load(data) {
    if (!data?.slots) return;
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    data.slots.forEach((entry, index) => {
      if (!entry || index >= TOTAL_SLOTS) return;
      const [id, count] = entry;
      if (id > 0 && count > 0) this.slots[index] = { id, count };
    });
    this.selected = Math.min(HOTBAR_SIZE - 1, Math.max(0, data.selected ?? 0));
    this.touch();
  }
}
