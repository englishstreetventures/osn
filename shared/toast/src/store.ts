import { createSignal } from "solid-js";

import type { Toast, ToastOptions, ToastTone } from "./types";

/**
 * The toast queue.
 *
 * A module-level signal rather than a context, deliberately: `toast.success(…)`
 * is called from event handlers, `catch` blocks and non-component modules all
 * over the apps, none of which sit inside a provider's reactive scope. A
 * context would force every one of those call sites to become a hook.
 *
 * The trade is that there is ONE queue per page. That is what we want — the
 * `<Toaster>` is mounted once at a page root, and a second one rendering the
 * same toasts twice would be a bug, not a feature.
 */
const [toasts, setToasts] = createSignal<Toast[]>([]);

export { toasts };

/** Timers keyed by toast id, so an update can restart a toast's clock. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a dismissing toast stays mounted so its exit animation can run.
 * Must stay >= the `--toast-exit-duration` the stylesheet uses; under
 * `prefers-reduced-motion` the animation collapses to ~0 and this just becomes
 * a short delay nobody sees.
 */
export const EXIT_MS = 200;

let seq = 0;
let autoId = 0;

/**
 * Hard cap on the QUEUE, as opposed to `Toaster`'s `limit`, which caps what
 * renders. The two are different: a toast that never mounts never starts its
 * own clock, so without a cap here a burst raised inside one Solid batch (every
 * event handler is batched) leaves the toasts beyond `limit` in the array for
 * the life of the page. Comfortably above any sane `limit`, so it only ever
 * catches runaway raises — a degraded backend pumping error toasts at a
 * long-lived tab.
 */
const MAX_QUEUED = 24;

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** Remove immediately, no exit animation. Used once the animation has run. */
export function remove(id: string) {
  clearTimer(id);
  setToasts((list) => list.filter((t) => t.id !== id));
}

/**
 * Start a toast leaving: mark it `dismissing` so the exit animation plays,
 * then drop it. Idempotent — dismissing an already-dismissing toast is a no-op
 * rather than a second timer racing the first.
 */
export function dismiss(id?: string) {
  if (id === undefined) {
    for (const t of toasts()) dismiss(t.id);
    return;
  }
  const current = toasts().find((t) => t.id === id);
  if (!current || current.dismissing) return;
  clearTimer(id);
  setToasts((list) => list.map((t) => (t.id === id ? { ...t, dismissing: true } : t)));
  timers.set(
    id,
    setTimeout(() => remove(id), EXIT_MS),
  );
}

/** (Re)start the auto-dismiss clock for a toast. `Infinity` pins it. */
export function scheduleDismiss(id: string, duration: number) {
  clearTimer(id);
  if (!Number.isFinite(duration)) return;
  timers.set(
    id,
    setTimeout(() => dismiss(id), duration),
  );
}

/** Stop a toast's clock — hover/focus pauses it, so a toast can be read. */
export function pause(id: string) {
  clearTimer(id);
}

/**
 * The dwell a toast gets when it does not ask for one. Long enough to read a
 * sentence, short enough not to nag.
 *
 * It lives here because the STORE owns the clock — see `upsert`. There is
 * deliberately no per-`Toaster` default: two owners of one timer is what made
 * the first cut of this fragile, and the only mount that ever passed one passed
 * exactly this value.
 */
export const DEFAULT_DURATION = 4000;

export interface UpsertInput extends ToastOptions {
  tone: ToastTone;
  message: Toast["message"];
}

/**
 * Raise a toast, or update the one already carrying this id.
 *
 * The update path is what makes `toast.promise` work: the same id goes from
 * `loading` to `success` in place, so the user sees one toast change rather
 * than a spinner vanishing and a tick appearing somewhere else in the stack.
 * An update also clears `dismissing`, so re-raising an id mid-exit revives it
 * rather than leaving a zombie that is about to disappear.
 */
export function upsert(input: UpsertInput): string {
  const id = input.id ?? `t${++autoId}`;
  const existing = toasts().find((t) => t.id === id);

  if (existing) {
    // Reviving a toast that was on its way out: kill the pending removal, or
    // the stale timer fires a moment later and takes the revived toast with it.
    // The item's effect restarts the dwell when `dismissing` flips back.
    if (existing.dismissing) clearTimer(id);
    // REPLACE the options rather than merging over them. An upsert declares the
    // toast's whole new state, and a merge would let the previous state's
    // fields leak into it — `toast.promise` turning a `loading` (pinned at
    // `Infinity`) into a `success` would carry that duration across and pin the
    // result on screen for ever. Only `seq` survives, so raise order holds.
    setToasts((list) =>
      list.map((t) => (t.id === id ? { ...input, id, seq: t.seq, dismissing: false } : t)),
    );
  } else {
    setToasts((list) => {
      const next = [...list, { ...input, id, seq: ++seq }];
      if (next.length <= MAX_QUEUED) return next;
      // Evict the oldest entries that are not already leaving — a dismissing
      // toast is mid-animation and owns its own removal.
      const overflow = next.length - MAX_QUEUED;
      const doomed = next.filter((t) => !t.dismissing).slice(0, overflow);
      for (const t of doomed) clearTimer(t.id);
      const drop = new Set(doomed.map((t) => t.id));
      return next.filter((t) => !drop.has(t.id));
    });
  }

  // The STORE starts the clock, not the rendered item — one owner. A toast
  // beyond the Toaster's `limit` never mounts, and a paused toast pushed out of
  // the visible window unmounts without `onMouseLeave` ever firing; with an
  // item-owned clock neither ever starts, and the entry sits in the queue for
  // the life of the page.
  scheduleDismiss(id, input.duration ?? DEFAULT_DURATION);
  return id;
}

/** Test seam — drop everything and cancel every timer. */
export function resetToasts() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  setToasts([]);
  seq = 0;
  autoId = 0;
}
