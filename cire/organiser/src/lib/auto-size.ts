import { createSignal, onCleanup, onMount } from "solid-js";

/**
 * Animate a box between two content heights it never knew in advance.
 *
 * CSS cannot transition to `height: auto`, and the two escapes both cost more
 * than they are worth here: a `max-height` guess runs the wrong duration at
 * every size, and `interpolate-size`/`calc-size()` is not in Safari, which is
 * most of the traffic to a wedding portal. So the height is measured and
 * written as a number, and the transition is an ordinary CSS one — meaning the
 * reduced-motion kill switch in `global.css` disarms it for free.
 *
 * Two elements: a `frame` that gets the height and clips, and the `content`
 * inside it that is measured. They must be different elements — writing a
 * height onto the element you are measuring is how these turn into a loop.
 *
 * ## Nothing is held at rest
 *
 * The frame carries a pixel height and `overflow: hidden` **only while it is
 * moving**, and is handed straight back to `height: auto` when the transition
 * ends. A box that kept them would be a permanent tax on everything inside it:
 * a sticky action bar sticks to the clip instead of the scrollport, a dropdown
 * that isn't portalled gets its list cut off, and a focus ring at the bottom
 * edge disappears. None of that is worth a 200ms slide.
 *
 * ## The cap
 *
 * A height animation is only pleasant over a short distance. Sliding 2,000px of
 * schedule open takes either an absurd duration or an absurd speed, and either
 * way the reader is watching a wipe instead of reading. So changes past `cap`
 * skip the animation entirely — which, given the paragraph above, means they
 * touch nothing at all.
 *
 * ## A reflow is not a change of content
 *
 * The height also changes when nothing was swapped: a window dragged narrower
 * rewraps the text inside and the box gets taller. Animating that means the
 * frame trails its own content for the whole drag, restarting a fresh 200ms
 * transition every frame and never finishing one. The tell is the **width**: a
 * content swap happens at a fixed width, a reflow does not. It is free to know —
 * the rect being measured for the height carries it.
 */

/** Past this many px, snap instead of animate. Roughly a tall laptop viewport. */
export const AUTO_SIZE_CAP = 480;

/**
 * Backstop for letting go of the height, in ms.
 *
 * `transitionend` is the real signal, and it is the one that normally fires.
 * But it does not fire for a transition that never started — a frame torn out
 * of the layout mid-move, a tab hidden before it settled — and a frame stuck at
 * a fixed height is exactly the state this hook exists to avoid. Comfortably
 * longer than `--dur-base`, so it never races the animation it guards.
 */
const RELEASE_MS = 800;

/**
 * Whether a change of height is short enough to be worth animating.
 *
 * Both ends are tested, so a collapse *from* something enormous snaps too — the
 * distance is what makes it unreadable, not the direction.
 */
export function autoSizeAnimates(from: number | null, to: number, cap = AUTO_SIZE_CAP): boolean {
  if (from === null) return false; // First measure. Nothing to travel from.
  return from <= cap && to <= cap;
}

export interface AutoSize {
  /** `ref` for the box that moves. Clipped and given a height while it does. */
  frame: (el: HTMLElement) => void;
  /** `ref` for the measured box. Must be the frame's child, not the frame. */
  content: (el: HTMLElement) => void;
  /** Last measured content height in px, or `null` before the first measure. */
  height: () => number | null;
}

export function createAutoSize(cap = AUTO_SIZE_CAP): AutoSize {
  const [height, setHeight] = createSignal<number | null>(null);

  let frameEl: HTMLElement | undefined;
  let contentEl: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Kept out of the signal for the same reason as the sliding pill's: what the
  // last height was is bookkeeping, not something to read back reactively.
  let last: number | null = null;
  // The content's width at the last measure. See "A reflow is not a change of
  // content" above.
  let lastWidth: number | null = null;

  /** Hand the box back to the layout. Safe to call when it never left. */
  function release() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!frameEl) return;
    frameEl.style.height = "";
    frameEl.style.overflow = "";
    frameEl.style.transition = "";
    frameEl.style.contain = "";
  }

  function onTransitionEnd(event: TransitionEvent) {
    // A transition on something *inside* the frame bubbles up through it. Only
    // the frame's own height is the one being waited on.
    if (event.target === frameEl && event.propertyName === "height") release();
  }

  function apply(next: number, width: number) {
    if (!frameEl) return;
    const from = last;
    const reflowed = lastWidth !== null && lastWidth !== width;
    lastWidth = width;
    if (from === next) return;
    last = next;
    setHeight(next);

    if (reflowed || !autoSizeAnimates(from, next, cap)) {
      release();
      return;
    }

    release();
    frameEl.style.overflow = "hidden";
    // For the length of the move only. The frame's own size is being driven from
    // out here, so nothing inside it can change what the rest of the page does —
    // which is exactly the promise `contain` makes, and it keeps a frame that is
    // animating from making the browser re-lay-out the page around it on every
    // one of the ~12 frames. Dropped again by `release()`, like the rest.
    frameEl.style.contain = "layout paint";
    frameEl.style.transition = "none";
    frameEl.style.height = `${from}px`;
    // Read layout back, so the browser commits the starting height as a style of
    // its own. Without it both writes land in one frame and there is nothing to
    // transition from.
    frameEl.getBoundingClientRect();
    frameEl.style.transition = "height var(--dur-base) var(--ease-out)";
    frameEl.style.height = `${next}px`;
    timer = setTimeout(release, RELEASE_MS);
  }

  function measure() {
    // One rect, read once, for both numbers. An element torn out of the document
    // measures zero on every axis, and a frame told it is 0px tall is a frame
    // that collapses the moment it is put back.
    if (!contentEl?.isConnected) return;
    const rect = contentEl.getBoundingClientRect();
    apply(rect.height, rect.width);
  }

  function start() {
    if (!contentEl || observer) return;
    // Content-box would miss a padding change; border-box is what the frame has
    // to be tall enough to hold.
    observer = new ResizeObserver(() => measure());
    observer.observe(contentEl, { box: "border-box" });
  }

  onMount(() => {
    start();
    measure();
    onCleanup(() => {
      observer?.disconnect();
      frameEl?.removeEventListener("transitionend", onTransitionEnd);
      if (timer !== undefined) clearTimeout(timer);
    });
  });

  return {
    frame: (el) => {
      frameEl = el;
      el.addEventListener("transitionend", onTransitionEnd);
      measure();
    },
    content: (el) => {
      contentEl = el;
      start();
      measure();
    },
    height,
  };
}
