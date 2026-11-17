import { createSignal } from "solid-js";

/**
 * A checklist row's popover opens with the focus on its panel, not on the
 * first thing inside it. Left to itself Kobalte focuses the first field or the
 * list, and Chromium draws the focus ring on that even after a mouse click,
 * so the organiser sees a ring on a field they never touched. The panel is
 * the `role="dialog"` element, `tabindex="-1"` with no outline of its own: a
 * screen reader hears the popover's name, and Tab or an arrow moves into it.
 *
 * Without scrolling: Kobalte mounts the panel at the page's top left and puts
 * it beside its trigger a frame later, and a scrolling focus would carry the
 * page up to that corner.
 *
 * Pass it as `Popover.Content`'s `onOpenAutoFocus`.
 */
export function focusPanelOnOpen(event: Event): void {
  const panel = event.currentTarget;
  if (!(panel instanceof HTMLElement)) return;
  event.preventDefault();
  panel.focus({ preventScroll: true });
}

/**
 * Which input opened a row's popover, for its `data-instant`. Opened with
 * Enter or Space on its trigger, the popover is there at once: a keyboard
 * action is repeated too often to wait on a growth. A pointer press on the
 * trigger lets it grow again. Spread `triggerProps` on `Popover.Trigger`,
 * whose own pointer handler runs these first.
 */
export function createOpenedBy() {
  const [instant, setInstant] = createSignal(false);
  return {
    instant,
    triggerProps: {
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") setInstant(true);
      },
      onPointerDown: () => setInstant(false),
    },
  };
}
