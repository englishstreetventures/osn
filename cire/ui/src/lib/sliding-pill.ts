/**
 * One indicator that moves between items, instead of one border per item.
 *
 * Every tab strip and every nav rail in the portal wants the same thing: a mark
 * on the active row that *travels* when the active row changes. Done per-item
 * (a border that turns on and off) the mark blinks between positions and the
 * label it sits beside jumps by the border's width. Done as a single absolutely
 * positioned box that is told where to be, it slides, and the labels never move
 * at all.
 *
 * The box is measured in **both axes**, not one. That is what lets the same
 * primitive drive a vertical rail and a horizontal strip — and, more usefully,
 * a horizontal strip that *wraps*: a pill that only knew about x would land on
 * the wrong line the moment the track reflowed.
 *
 * Motion is a plain CSS transition on the returned style, and a reader who has
 * turned motion down gets none: the pill jumps (`prefers-reduced-motion`, read
 * here, so a surface with no kill switch of its own is covered too). There is
 * no animation library in this package, by design.
 *
 * Two moves: `out`, the default, for a mark arriving at a row (the module
 * rail), and `spring`, for the glass of a segmented strip
 * (`segmented-tabs.tsx`): its place on a firm spring, its size eased out.
 *
 * The consumer owns two rules the hook cannot enforce: the track must be a
 * containing block (`relative`), and the pill must be `absolute` with `inset-0`
 * unset — it takes its whole geometry from `style()`.
 */
import { batch, createEffect, createSignal, type JSX, onCleanup, onMount } from "solid-js";

/** The subset of DOMRect the geometry needs. Named so the maths can be tested. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the pill should be, in the track's own coordinates. */
export interface PillBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The pill's position relative to the track's padding box.
 *
 * Rect maths rather than `offsetLeft` so the item may sit at any depth under the
 * track without the caller having to guarantee it is the offset parent, and so a
 * scrolled track (an overflowing tab strip) stays correct.
 *
 * Returns `null` for a zero-area item, which is how a surface hidden by
 * `display: none` reports itself — the rail and the sheet render the same nav
 * twice, and the hidden copy must not claim a position.
 */
export function pillBox(
  track: RectLike,
  item: RectLike,
  scroll: { left: number; top: number } = { left: 0, top: 0 },
): PillBox | null {
  if (item.width <= 0 && item.height <= 0) return null;
  return {
    x: item.left - track.left + scroll.left,
    y: item.top - track.top + scroll.top,
    width: item.width,
    height: item.height,
  };
}

/** Whether two boxes describe the same place. */
export function samePlace(a: PillBox, b: PillBox): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** How the pill moves. */
export type PillEase = "out" | "spring";

const EASE_OUT = "var(--ease-out,var(--ui-ease-out,cubic-bezier(0.22,1,0.36,1)))";
const DUR_BASE = "var(--dur-base,var(--ui-dur-base,200ms))";
const DUR_SLOW = "var(--dur-slow,var(--ui-dur-slow,320ms))";

/**
 * The timing of the pill's place and of its size. Each reads the app's own
 * token first and the contract's after, so the pill moves on a surface that
 * maps only the contract.
 *
 * `spring` is the glass of a segmented strip, moving as the owner chose: its
 * place glides on the app's `--ease-glide`, a spring firm enough to go no
 * more than 3% past, and falls back to ease-out where an app has none, never
 * to the bouncier `--ease-spring`. Its size eases out, so the glass never
 * grows past the tab it lands on. Both run on `--dur-slow`, one clock, so the
 * move reads as one event.
 */
const MOVE = {
  out: { place: `${DUR_BASE} ${EASE_OUT}`, size: `${DUR_BASE} ${EASE_OUT}` },
  spring: {
    place: `${DUR_SLOW} var(--ease-glide,${EASE_OUT})`,
    size: `${DUR_SLOW} ${EASE_OUT}`,
  },
} as const satisfies Readonly<Record<PillEase, { place: string; size: string }>>;

/**
 * The pill's inline style.
 *
 * `settled` is false for the first frame at a new position and on the frame the
 * pill first appears, so it arrives where it belongs instead of sliding in from
 * the track's corner.
 *
 * Position moves by `transform` rather than `left`/`top`, which is the half of
 * this that is composited. `width` and `height` are not, and they are in the
 * list on purpose: the tab strip's items are genuinely different widths, and a
 * pill that slid to a new place and then snapped to a new size would read as two
 * events. The pill is `position: absolute` and childless, so the layout it costs
 * is its own and touches no sibling.
 *
 * A change of place mid-move is a CSS transition retargeted: it starts from
 * where the pill is on screen, so it never jumps, though it starts at the
 * curve's own speed rather than the pill's.
 */
export function pillStyle(
  box: PillBox | null,
  settled: boolean,
  ease: PillEase = "out",
): JSX.CSSProperties {
  if (!box) return { opacity: 0, transition: "none" };
  const { place, size } = MOVE[ease];
  return {
    opacity: 1,
    transform: `translate3d(${box.x}px, ${box.y}px, 0)`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    transition: settled ? `transform ${place}, width ${size}, height ${size}` : "none",
  };
}

/**
 * Whether the reader has asked for less motion, as a signal that follows the
 * setting. One query per pill, read once and then on its `change`.
 */
function createMotionReduced(): () => boolean {
  const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  const [reduced, setReduced] = createSignal(query?.matches ?? false);
  if (query) {
    const follow = () => setReduced(query.matches);
    query.addEventListener("change", follow);
    onCleanup(() => query.removeEventListener("change", follow));
  }
  return reduced;
}

export interface SlidingPill {
  /** `ref` for the track. Must be the pill's containing block. */
  track: (el: HTMLElement) => void;
  /** `ref` factory for each item, keyed by the same value `active` returns. */
  item: (key: string) => (el: HTMLElement) => void;
  /** `style` for the pill element. */
  style: () => JSX.CSSProperties;
}

/**
 * @param active the key of the item the pill should sit on.
 * @param options.ease how it moves: `out` (default) or `spring`.
 */
export function createSlidingPill(
  active: () => string,
  options: { ease?: PillEase } = {},
): SlidingPill {
  const items = new Map<string, HTMLElement>();
  const [box, setBox] = createSignal<PillBox | null>(null);
  const [settled, setSettled] = createSignal(false);
  const motionReduced = createMotionReduced();

  let trackEl: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let mounted = false;
  // The previous box is kept out here rather than read back off the signal:
  // `measure` runs inside an effect, and reading what it is about to write
  // would make the effect depend on its own output.
  let last: PillBox | null = null;
  // The track's width at the last measure, to tell a move apart from a reflow.
  let lastWidth: number | null = null;

  function measure() {
    const el = items.get(active());
    if (!trackEl || !el?.isConnected) {
      last = null;
      lastWidth = null;
      batch(() => {
        setBox(null);
        setSettled(false);
      });
      return;
    }
    const track = trackEl.getBoundingClientRect();
    const next = pillBox(track, el.getBoundingClientRect(), {
      left: trackEl.scrollLeft,
      top: trackEl.scrollTop,
    });
    // A window being dragged fires the observer every frame, and the pill's new
    // place each time is not a move the host made — it is the old place, in a
    // track that is now a different width. Sliding to it means the pill lags the
    // label it belongs to for the whole drag, restarting a 200ms transition it
    // never finishes. Same width, different place: a real move. Free to read,
    // since the rect was needed anyway.
    const reflowed = lastWidth !== null && lastWidth !== track.width;
    lastWidth = track.width;
    // A ResizeObserver reports on every reflow, most of which move nothing.
    // Bail on an unchanged box so the style is not rewritten for no reason.
    if (next && last && samePlace(last, next)) return;
    // Appearing is not a move either. Place it, then arm the transition on the
    // next frame so only *subsequent* changes of active row animate.
    const appearing = next !== null && last === null;
    last = next;
    batch(() => {
      setBox(next);
      if (next === null || appearing || reflowed) setSettled(false);
    });
    if (next !== null && (appearing || reflowed)) requestAnimationFrame(() => setSettled(true));
  }

  function watch(el: HTMLElement) {
    // One observer over the track and every item. The track catches reflow and
    // wrapping; the items catch a label that changes width on its own — a
    // webfont swapping in under a preloaded fallback is the common case, and it
    // lands after the first measure.
    observer ??= new ResizeObserver(() => measure());
    observer.observe(el);
    // Released with the element, not with the component. A tab strip inside a
    // `<For>` rebuilds every row on each module switch, and an observation the
    // element never gets back holds the dead row and its subtree reachable,
    // lengthens every subsequent delivery, and fires one spurious measure per
    // switch. `disconnect()` on unmount covers the end; this covers the churn.
    onCleanup(() => observer?.unobserve(el));
  }

  onMount(() => {
    mounted = true;
    measure();
    onCleanup(() => observer?.disconnect());
  });

  createEffect(() => {
    active();
    if (mounted) measure();
  });

  return {
    track: (el) => {
      trackEl = el;
      watch(el);
      if (mounted) measure();
    },
    item: (key) => (el) => {
      items.set(key, el);
      watch(el);
      onCleanup(() => {
        if (items.get(key) === el) items.delete(key);
      });
      // A ref runs before its element is in the document; one that is not yet
      // waits for the observer's first report, rather than reading no layout.
      if (mounted && el.isConnected) measure();
    },
    style: () => pillStyle(box(), settled() && !motionReduced(), options.ease),
  };
}
