// A one-click delete the organiser can take back: the row leaves the list at
// once, a toast offers Undo for its life, and the delete is sent only once that
// toast has gone without Undo. Every ✕ that deletes a row with no confirmation
// goes through here, so the checklist, the budget and the gift list behave the
// same. Frontend code: no Effect.
import { toast, toasts } from "@shared/toast";
import { batch, createEffect, createRoot, createSignal } from "solid-js";

import { haptic } from "./touch-feedback";

/**
 * How long a delete can be taken back: the undo toast's own dwell. The toast's
 * clock is the window, so it pauses with the toast while the pointer or focus
 * is on it, and a toast held there holds its delete back with it.
 */
export const UNDO_MS = 5000;

/** The class every undo toast carries; the portal's stylesheet makes one leave at once. */
const UNDO_TOAST_CLASS = "undo-toast";

export interface UndoableDelete {
  /**
   * The row's name in this helper, unique across lists: `task:<id>`, say. The
   * row's ✕ carries it as `data-undo-key`, so Undo can hand focus back to it.
   */
  key: string;
  /** What the toast says while Undo is offered: `Deleted “Book the venue”`. */
  message: string;
  /**
   * The Undo button's name for a screen reader, which starts with "Undo" and
   * names the row: `Undo deleting “Book the venue”`. Several undo toasts can
   * be up at once, and a list of buttons all called "Undo" says nothing.
   */
  undoName: string;
  /** What a second toast says once Undo has put the row back. */
  restored: string;
  /** Take the row off the screen. Runs at once. */
  hide: () => void;
  /** Put the row back as it was. Runs when Undo is pressed; nothing was sent. */
  restore: () => void;
  /**
   * Send the delete. Runs once, when the toast has gone without Undo, or as the
   * page is left with the toast still up — then with `keepalive`, so the
   * request outlives the page.
   */
  commit: (init: { keepalive: boolean }) => Promise<void> | void;
}

interface Pending {
  row: UndoableDelete;
  toastId: string;
  /** Stops watching the toast. */
  stop: () => void;
}

const pending = new Map<string, Pending>();

const [returning, setReturning] = createSignal<ReadonlySet<string>>(new Set());

/**
 * The row is waiting on its toast: hidden, and not yet deleted on the server.
 * A list whose reads are not held back by its own writes filters these out of
 * what it reads, or a read in the window would put the row back.
 */
export function isPendingDelete(key: string): boolean {
  return pending.has(key);
}

/**
 * The row came back by Undo and has not finished arriving. Reactive: the row
 * carries the `row-return` animation while this holds, and calls
 * {@link returned} when it ends, so a later rebuild of the row does not fade
 * it in a second time.
 */
export function isReturning(key: string): boolean {
  return returning().has(key);
}

export function returned(key: string): void {
  if (!returning().has(key)) return;
  setReturning((keys) => {
    const next = new Set(keys);
    next.delete(key);
    return next;
  });
}

/** Take a delete off the pending list. False when it had already settled. */
function take(entry: Pending): boolean {
  if (pending.get(entry.row.key) !== entry) return false;
  pending.delete(entry.row.key);
  entry.stop();
  if (pending.size === 0) window.removeEventListener("pagehide", flush);
  return true;
}

/** The toast went without Undo: the delete is final. */
function settle(entry: Pending, keepalive: boolean): void {
  if (!take(entry)) return;
  void entry.row.commit({ keepalive });
}

/** The toast `id` names, as the package draws it, or nothing once it has gone. */
const toastElement = (id: string) =>
  document.querySelector<HTMLElement>(`.ui-toast[data-toast-id="${CSS.escape(id)}"]`);

/** The ✕ of the row `key` names, once the list has drawn it. */
const crossOf = (key: string) =>
  document.querySelector<HTMLElement>(`[data-undo-key="${CSS.escape(key)}"]`);

function undo(entry: Pending): void {
  if (!take(entry)) return;
  // Focus is on the Undo about to go, or on nothing: hand it to the row's ✕
  // so a keyboard user carries on where the row is. Focus elsewhere — a field
  // the pointer left to press Undo — stays where it is.
  const active = document.activeElement;
  const lost = !active || active === document.body;
  const handBack = lost || !!toastElement(entry.toastId)?.contains(active);
  batch(() => {
    setReturning((keys) => new Set(keys).add(entry.row.key));
    entry.row.restore();
  });
  // Before the toast's own dismiss runs: focus that leaves a toast resumes its
  // clock, and the dismiss that follows stops it again.
  if (handBack) crossOf(entry.row.key)?.focus();
  haptic("commit");
  // The restore is announced the way the delete was: a toast, in its own live region.
  toast.success(entry.row.restored);
}

/**
 * The page is going away with toasts still up: send every pending delete now,
 * kept alive, and drop its toast. A page the browser later restores from its
 * cache reloads (`bfcache.ts`), so nothing is offered back.
 */
function flush(): void {
  // Deleting the entry a Map iterator is on is safe: the walk goes on to the next.
  for (const entry of pending.values()) {
    settle(entry, true);
    toast.remove(entry.toastId);
  }
}

/**
 * Delete a row so that it can be taken back.
 *
 * Nothing leaves the server until the toast has gone, so Undo needs no request
 * and puts back the very row that was there — its id, and everything that
 * hangs off it (a task's holders, a line's payments, a gift's claims and
 * picture). A re-created row would have none of them.
 *
 * `click` is the ✕'s click. One with no pointer behind it (`detail` 0: Enter
 * or Space, or a screen reader pressing the button) moves focus to the
 * toast's Undo. The toast sits at the end of the page, past every row, and its
 * clock stops while focus is inside it, so a keyboard user reaches Undo and
 * keeps it for as long as they stay there.
 */
export function deleteWithUndo(row: UndoableDelete, click?: MouseEvent): void {
  row.hide();
  haptic("commit");
  const entry: Pending = { row, toastId: "", stop: () => {} };
  entry.toastId = toast.success(row.message, {
    duration: UNDO_MS,
    class: UNDO_TOAST_CLASS,
    action: { label: "Undo", ariaLabel: row.undoName, onClick: () => undo(entry) },
  });
  if (click?.detail === 0) {
    // Once the toast is drawn and its container has entered the top layer.
    queueMicrotask(() =>
      toastElement(entry.toastId)?.querySelector<HTMLElement>(".ui-toast__action")?.focus(),
    );
  }
  if (pending.size === 0) window.addEventListener("pagehide", flush);
  pending.set(row.key, entry);
  // The toast's life is its time in the queue: it leaves once its clock runs
  // out (or anything dismisses it) and its exit has run. Watched from a root
  // of its own, so the view that raised it can unmount meanwhile.
  createRoot((dispose) => {
    entry.stop = dispose;
    createEffect(() => {
      if (!toasts().some((t) => t.id === entry.toastId)) settle(entry, false);
    });
  });
}
