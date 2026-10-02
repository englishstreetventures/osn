import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";

/**
 * Whether the guest has scrolled the page yet: false until the first scroll
 * that moves the page below its top, then true for good. Scrolling back to the
 * top does not reset it.
 *
 * False in the server render, which never runs `onMount`, so the HTML always
 * carries the unscrolled state. At mount it reads the position once, so a page
 * the browser restored part-way down reads as scrolled without waiting for an
 * event. The listener is passive and is removed as soon as it latches, or when
 * the owner is disposed.
 *
 * A remounted owner starts again from the position at its own mount.
 */
export function createFirstScroll(): Accessor<boolean> {
  const [scrolled, setScrolled] = createSignal(false);

  const onScroll = () => {
    // `> 0`, not `!== 0`: iOS rubber-banding reports a negative offset when
    // the guest pulls the top of the page down.
    if (window.scrollY <= 0) return;
    setScrolled(true);
    window.removeEventListener("scroll", onScroll);
  };

  // Everything that touches `window` is inside `onMount`, cleanup included:
  // the server build runs `onCleanup` when it disposes the render, and has no
  // `window`.
  onMount(() => {
    onScroll();
    if (scrolled()) return;
    window.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => window.removeEventListener("scroll", onScroll));
  });

  return scrolled;
}
