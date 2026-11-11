import { onCleanup } from "solid-js";

/**
 * A control that takes focus under `target` stops clear of a save bar fixed or
 * stuck to the foot of the window: the bar's measured height (`--save-bar-h`,
 * written by `trackSaveBarHeight`) plus half a rem. A browser counts a control
 * behind the bar as in view and scrolls nowhere for it; the margin makes it
 * scroll (WCAG 2.4.11). Goes on the box that holds the rows, never on the bar,
 * whose own buttons must not move the page.
 */
export const CLEAR_OF_SAVE_BAR =
  "[&_:is(button,input,select,textarea,a,[tabindex])]:scroll-mb-[calc(var(--save-bar-h,0px)+0.5rem)]";

/**
 * Writes `bar`'s height as `--save-bar-h` on `target`, and again whenever it
 * changes (an error row joins the bar, its line wraps). The offset is measured,
 * never a guess: the bar's content grows. Call it from the bar's `ref`, so the
 * observer and the property end with the bar.
 */
export function trackSaveBarHeight(bar: HTMLElement, target: HTMLElement | null | undefined) {
  if (!target || typeof ResizeObserver === "undefined") return;
  let written: string | undefined;
  const write = () => {
    const value = `${bar.getBoundingClientRect().height}px`;
    if (value === written) return;
    written = value;
    target.style.setProperty("--save-bar-h", value);
  };
  queueMicrotask(write);
  const observer = new ResizeObserver(write);
  observer.observe(bar, { box: "border-box" });
  onCleanup(() => {
    observer.disconnect();
    written = undefined;
    target.style.removeProperty("--save-bar-h");
  });
}
