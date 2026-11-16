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
