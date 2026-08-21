import { createSignal, createUniqueId, type Accessor, type JSX } from "solid-js";

import type { Id } from "./types";

export type DragPhase = "pickup" | "step" | "commit";

/** What a grip button needs, beyond whatever the consumer adds. */
export interface GripProps extends JSX.HTMLAttributes<HTMLButtonElement> {
  type: "button";
  "aria-label": string;
  "aria-describedby": string;
  ref: (el: HTMLButtonElement) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/** One row's slice of the list: the grip, and the two move controls. */
export interface SortableItem {
  gripProps: () => GripProps;
  moveProps: (delta: -1 | 1) => MoveProps;
  moveLabel: (delta: -1 | 1) => string;
}

/** What one screen-reader move control needs. */
export interface MoveProps extends JSX.HTMLAttributes<HTMLButtonElement> {
  type: "button";
  disabled: boolean;
  onClick: () => void;
}

export interface SortableListOptions {
  /** The list's ids, in current order. */
  ids: Accessor<Id[]>;
  /** A human name for an item, used in labels and announcements. */
  labelFor: (id: Id) => string;
  /** What one item is called, for the instructions ("Drag to re-order this event"). */
  noun: string;
  /** Commit a move. Called for both pointer drops and keyboard moves. */
  onMove: (from: number, to: number) => void;
  /** Optional feedback hook — haptics, sound. Kept out of the package. */
  onPhase?: (phase: DragPhase) => void;
}

/**
 * The accessibility half of a sortable list, which is most of it.
 *
 * A drag affordance is invisible to a screen-reader user and unreachable from a
 * keyboard unless every one of the following is supplied. None is optional, and
 * each has a failure mode that is silent rather than obvious — which is exactly
 * why they belong in a package rather than in each list that wants dragging:
 *
 * 1. **The grip is a real `<button>`** that owns Arrow Up/Down, with
 *    `preventDefault()` BEFORE the bounds check so a focused grip owns the
 *    arrows unconditionally rather than sometimes moving the row and sometimes
 *    scrolling the page out from under it.
 * 2. **`sr-only` move buttons as well as the arrows.** NVDA and JAWS run in
 *    browse mode by default and consume unmodified arrow keys for their own
 *    virtual cursor, forwarding them to a plain `<button>` only in focus mode,
 *    which buttons do not trigger. Without an Enter/Space-activated control, a
 *    screen-reader user reads the hint, presses the arrows, and gets nothing.
 *    They are `focus:not-sr-only` so a sighted keyboard user never lands on an
 *    invisible control (WCAG 2.4.7), and `disabled` at the ends so assistive
 *    tech reports the boundary instead of the user pressing into nothing.
 * 3. **Focus is restored explicitly** after a keyboard move. A keyed `<For>`
 *    MOVES the row's node rather than re-creating it, but a DOM move is a
 *    remove-then-insert and focus does not survive it — without this, one
 *    keypress moves the row and focus lands on `<body>`, so the row cannot be
 *    walked any further.
 * 4. **Every move is announced** through a polite live region, and the
 *    announcement **clears before it sets**: a live region only speaks when its
 *    text changes, and walking one row down a list produces the identical
 *    sentence every time, so setting it straight would make the second press
 *    silent.
 * 5. **Auto-repeat is ignored.** Repeat fires ~30x/s, and a consumer's `onMove`
 *    is typically a draft checkpoint plus a revalidation — a held key would
 *    both stall the list and burn through an undo stack in seconds.
 *
 * Ids are generated per instance rather than hardcoded, so several lists can
 * coexist on one page without colliding `aria-describedby` targets.
 */
export function createSortableList(options: SortableListOptions) {
  const hintId = createUniqueId();
  const [announcement, setAnnouncement] = createSignal("");
  /** The grip node per id, so focus can be put back after a keyboard move. */
  const grips = new Map<Id, HTMLButtonElement>();
  /** The slot the pointer was last over, so only a real change ticks. */
  let lastOverId: Id | null = null;

  function announce(id: Id, to: number) {
    // Clear FIRST — see obligation 4 above. Solid applies each set
    // synchronously, so this is two real DOM writes: empty, then the message.
    setAnnouncement("");
    setAnnouncement(
      `${options.labelFor(id)} moved to position ${to + 1} of ${options.ids().length}.`,
    );
  }

  /**
   * Undo and discard rewind the order without going through `move`, so the
   * region would otherwise keep asserting a move that has just been reversed.
   * Cleared rather than re-announced: an undo may have reverted something other
   * than a re-order, and guessing which would be worse than silence.
   */
  const clearAnnouncement = () => setAnnouncement("");

  function move(index: number, delta: -1 | 1) {
    const ids = options.ids();
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const id = ids[index]!;
    options.onMove(index, target);
    announce(id, target);
    options.onPhase?.("commit");
    // Restore focus AFTER the move — see obligation 3.
    grips.get(id)?.focus();
  }

  /** Wire the provider's drag callbacks so phases and announcements are shared
   *  with the pointer path rather than duplicated by the consumer. */
  const dragHandlers = {
    onDragStart: () => {
      lastOverId = null;
      options.onPhase?.("pickup");
    },
    onDragOver: ({ droppable }: { droppable: { id: Id } | null }) => {
      const id = droppable?.id ?? null;
      if (id === lastOverId) return;
      lastOverId = id;
      if (id !== null) options.onPhase?.("step");
    },
    onDragEnd: ({
      draggable,
      droppable,
    }: {
      draggable: { id: Id };
      droppable: { id: Id } | null;
    }) => {
      lastOverId = null;
      if (!droppable) return;
      const ids = options.ids();
      const from = ids.indexOf(draggable.id);
      const to = ids.indexOf(droppable.id);
      if (from === -1 || to === -1 || from === to) return;
      const id = ids[from]!;
      options.onMove(from, to);
      announce(id, to);
      // Only a drop that actually moved something is worth confirming — a row
      // dropped back where it started has changed nothing.
      options.onPhase?.("commit");
    },
  };

  /** Props for the shared instructions every grip points at. */
  const hintProps = () => ({ id: hintId, class: "sr-only" });

  /** Props for the live region. `aria-live` as well as the role, because some
   *  AT/browser pairs only honour one of them. */
  const liveRegionProps = () => ({
    class: "sr-only",
    role: "status" as const,
    "aria-live": "polite" as const,
  });

  function item(id: Id, index: Accessor<number>, count: Accessor<number>): SortableItem {
    return {
      /** Spread onto the grip button, BEFORE `dragActivators`' own handlers. */
      gripProps: (): GripProps => ({
        type: "button",
        "aria-label": `Reorder ${options.labelFor(id)}, position ${index() + 1} of ${count()}`,
        "aria-describedby": hintId,
        ref: (el: HTMLButtonElement) => grips.set(id, el),
        onKeyDown: (event: KeyboardEvent) => {
          const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
          if (delta === 0) return;
          // Before the bounds check — see obligation 1.
          event.preventDefault();
          // See obligation 5.
          if (event.repeat) return;
          move(index(), delta as -1 | 1);
        },
      }),
      /** Props for one screen-reader move control. See obligation 2. */
      moveProps: (delta: -1 | 1): MoveProps => ({
        type: "button",
        disabled: delta === -1 ? index() === 0 : index() === count() - 1,
        onClick: () => move(index(), delta),
      }),
      moveLabel: (delta: -1 | 1) => `Move ${options.labelFor(id)} ${delta === -1 ? "up" : "down"}`,
    };
  }

  return {
    hintId,
    hintProps,
    hintText: `Drag to re-order, or press the up and down arrow keys to move this ${options.noun}. Move up and move down buttons follow this handle.`,
    liveRegionProps,
    announcement,
    clearAnnouncement,
    dragHandlers,
    item,
    move,
  };
}
