/**
 * Bring a redrawn list back to the foot of the stuck chrome.
 *
 * A host deep in a long list who narrows it — a search, a reply filter, a
 * sort, another event — would otherwise be left looking at whatever now sits
 * that far down the page, or at nothing. So once the list has redrawn, if its
 * top is above the foot of the stuck stack (the top bar, the view bar, and any
 * layer above the results), the page moves by exactly the distance that puts
 * it there; if its top is already at or below the foot, nothing moves. Focus
 * stays where it is — in the search field, typically.
 *
 * Where the shorter list no longer reaches, the browser clamps the page first,
 * so the guarantee is that the first result is not under the stack, not that
 * it sits exactly at the foot.
 */

/**
 * How far to scroll (negative is up) so a list whose top is `resultsTop` in
 * the window starts at `stackFoot`. Zero when it already starts there or
 * below; a gap of a pixel or less is layout rounding, not a list out of view.
 */
export function scrollDelta(resultsTop: number, stackFoot: number): number {
  return resultsTop < stackFoot - 1 ? resultsTop - stackFoot : 0;
}

/** Move the page so `results` starts at `stackFoot`, if it starts above it. */
export function scrollToResults(results: Element, stackFoot: number): void {
  const move = scrollDelta(results.getBoundingClientRect().top, stackFoot);
  if (move !== 0) window.scrollBy({ top: move, behavior: "instant" });
}

/**
 * Where the stuck chrome above a view ends: the bottom of the view bar when
 * the module draws one, else the top bar's, read from the page as it is now.
 * The view bar is the last layer above a list's own head row, which is part of
 * the list, so this is the line a list's top is brought to.
 */
export function chromeFoot(from: Element): number {
  const bar = document.querySelector("[data-view-bar]");
  if (bar) return bar.getBoundingClientRect().bottom;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:var(--chrome-h)";
  from.parentElement?.append(probe);
  const height = probe.offsetHeight;
  probe.remove();
  return height;
}
