/**
 * A pointer resting on a trigger, and leaving it and what it opened.
 *
 * `onDwell` runs once a mouse or pen pointer has stayed on the trigger for
 * `openDelay`. `onLeave` runs once it has been off both the trigger and the
 * card for `closeDelay`; moving from one to the other inside that window — the
 * gutter between a nav row and the card beside it — counts as staying. Touch is
 * ignored in both directions: a touch has no hover, so whatever this opens has
 * to open on a press as well.
 *
 * Timers only. The caller decides what opening and closing mean, and whether
 * a leave closes anything — a card someone pressed open, or tabbed into, stays.
 * Both timers die with the owner that created this.
 */
import { onCleanup } from "solid-js";

export interface PointerDwell {
  /** The pointer reached the trigger. */
  enterTrigger: (event: PointerEvent) => void;
  /** The pointer reached what the dwell opened. */
  enterCard: (event: PointerEvent) => void;
  /** The pointer left the trigger or the card. */
  leave: (event: PointerEvent) => void;
  /** Drop both timers. */
  cancel: () => void;
}

export function createPointerDwell(options: {
  openDelay: number;
  closeDelay: number;
  onDwell: () => void;
  onLeave: () => void;
}): PointerDwell {
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const stopOpening = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
  };
  const stopClosing = () => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const cancel = () => {
    stopOpening();
    stopClosing();
  };
  onCleanup(cancel);

  const isTouch = (event: PointerEvent) => event.pointerType === "touch";

  return {
    enterTrigger(event) {
      if (isTouch(event)) return;
      stopClosing();
      openTimer ??= setTimeout(() => {
        openTimer = undefined;
        options.onDwell();
      }, options.openDelay);
    },
    enterCard(event) {
      if (isTouch(event)) return;
      stopClosing();
    },
    leave(event) {
      if (isTouch(event)) return;
      stopOpening();
      closeTimer ??= setTimeout(() => {
        closeTimer = undefined;
        options.onLeave();
      }, options.closeDelay);
    },
    cancel,
  };
}
