/**
 * The decisions behind swiping between `EventSheet`'s two panels, kept apart
 * from the DOM wiring so each threshold is pinned by a test of its own.
 *
 * The panels sit side by side in the guest's mind: the details on the start
 * side, the RSVP form on the end side, in the order of the event card's
 * buttons. So a finger moving toward the start (`dx < 0`) pulls the form in
 * over the details, and one moving toward the end pulls the details back.
 */

/** The sheet's two panels. */
export type SwipePanel = "details" | "rsvp";

/** Movement a touch makes before it is read as a swipe rather than a tap. */
const SLOP_PX = 10;
/** Share of the panel's width past which a released drag carries on over. */
const COMMIT_SHARE = 0.3;
/** Speed toward the other panel, in px per ms, that carries a short drag over. */
const FLICK_PX_PER_MS = 0.35;
/** The shortest drag a flick may commit, so a fast twitch does not. */
const FLICK_MIN_PX = 24;
/** How far back a release looks to measure the finger's speed. */
const VELOCITY_WINDOW_MS = 100;

/** The sign of a horizontal move that leads from `panel` to the other one. */
function towardOther(panel: SwipePanel): -1 | 1 {
  return panel === "details" ? -1 : 1;
}

/**
 * Whether a touch has moved far enough, either way, to be read as a gesture
 * at all. Until it has, {@link beginsDrag} has nothing to decide.
 */
export function pastSlop(dx: number, dy: number): boolean {
  return Math.max(Math.abs(dx), Math.abs(dy)) > SLOP_PX;
}

/**
 * Whether a touch that has moved `dx`, `dy` from where it went down is a
 * swipe toward the other panel. False is final for that touch: a move that
 * starts vertical is the browser's scroll, and one toward the side with no
 * panel has nowhere to go.
 */
export function beginsDrag(move: { dx: number; dy: number; panel: SwipePanel }): boolean {
  const { dx, dy, panel } = move;
  return (
    Math.abs(dx) > SLOP_PX && Math.abs(dx) > Math.abs(dy) && Math.sign(dx) === towardOther(panel)
  );
}

/**
 * Whether a touch that has moved `dx`, `dy` is a sideways pull toward the side
 * with no panel. It goes nowhere: the panel gives a little under the finger
 * ({@link bandOffset}) and springs back, the way content dragged past its end
 * does on iOS. It never leaves the panel, so it is allowed whether or not the
 * other panel could be reached.
 */
export function beginsBand(move: { dx: number; dy: number; panel: SwipePanel }): boolean {
  const { dx, dy, panel } = move;
  return (
    Math.abs(dx) > SLOP_PX && Math.abs(dx) > Math.abs(dy) && Math.sign(dx) === -towardOther(panel)
  );
}

/** How much of a finger's travel past an edge a touch moves the panel at first. */
const BAND_COEFFICIENT = 0.55;

/**
 * How far a panel moves for a finger `x` past its edge, on a view `d` long:
 * `c·x·d / (d + c·x)`, UIKit's rubber band. It starts at `c` of the finger's
 * travel and gives less the further the finger goes, never reaching `d`, so a
 * pull past an edge is felt rather than stopped dead. Odd: the sign is the
 * finger's.
 */
export function rubberBand(x: number, d: number, c = BAND_COEFFICIENT): number {
  const pull = Math.abs(x);
  return (Math.sign(x) * c * pull * d) / (d + c * pull);
}

/**
 * How fast the panel moves per unit of finger at `x` past the edge — the
 * rubber band's slope, `c / (1 + c·|x|/d)²`. A release from the band hands
 * the spring the panel's speed, which is this share of the finger's.
 */
export function bandSlope(x: number, d: number, c = BAND_COEFFICIENT): number {
  return c / (1 + (c * Math.abs(x)) / d) ** 2;
}

/**
 * The panels' offset for a finger at `dx` in a swipe. Between where it
 * started and the other panel's resting place the panels follow the finger
 * exactly; past either end they move by {@link rubberBand} of the overshoot.
 */
export function clampOffset(dx: number, panel: SwipePanel, width: number): number {
  const travel = dx * towardOther(panel);
  if (travel < 0) return rubberBand(dx, width);
  if (travel > width) return towardOther(panel) * (width + rubberBand(travel - width, width));
  return dx;
}

/**
 * The panel's offset for a finger at `dx` in a pull toward the side with no
 * panel ({@link beginsBand}): the rubber band on that side, and 0 once the
 * finger comes back past where it started — with no panel drawn in, there is
 * nothing to show on the other side.
 */
export function bandOffset(dx: number, panel: SwipePanel, width: number): number {
  return dx * towardOther(panel) < 0 ? rubberBand(dx, width) : 0;
}

/**
 * The spring a released swipe settles on: a 0.3s response (stiffness
 * `(2π/0.3)²`), critically damped so a page lands without bouncing, and at
 * rest within a pixel. It starts at the finger's speed, which a fixed-length
 * ease cannot. A full panel's width settles in about 0.4s, 95% of the way by
 * about 0.23s.
 */
export const SETTLE_SPRING = {
  stiffness: 439,
  damping: 2 * Math.sqrt(439),
  mass: 1,
  restDelta: 1,
  restSpeed: 30,
} as const;

/** Whether a drag released at `dx`, moving at `velocity` px/ms, carries on to the other panel. */
export function shouldCommit(release: {
  dx: number;
  velocity: number;
  width: number;
  panel: SwipePanel;
}): boolean {
  const toward = towardOther(release.panel);
  const distance = release.dx * toward;
  if (distance > release.width * COMMIT_SHARE) return true;
  return distance > FLICK_MIN_PX && release.velocity * toward > FLICK_PX_PER_MS;
}

/** One position of the finger, at an event's `timeStamp`. */
export interface SwipeSample {
  x: number;
  t: number;
}

/**
 * The finger's speed in px per ms over the last {@link VELOCITY_WINDOW_MS} of
 * samples, newest last; 0 without two samples in that window.
 */
export function velocityOf(samples: readonly SwipeSample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  // Always found: the last sample is inside its own window.
  const first = samples.find((s) => last.t - s.t <= VELOCITY_WINDOW_MS)!;
  const span = last.t - first.t;
  return span > 0 ? (last.x - first.x) / span : 0;
}

const TEXT_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * Whether a touch that went down on `target` belongs to something other than
 * the sheet: a text field, where a sideways drag moves the caret, or a box
 * between it and `root` that itself scrolls sideways — the dietary chips, the
 * moodboard — where the drag is that box's scroll. `computed` is
 * `getComputedStyle`, passed in so the layout question can be answered
 * without a layout engine.
 */
export function startsInside(
  target: Element,
  root: Element,
  computed: (el: Element) => Pick<CSSStyleDeclaration, "overflowX">,
): boolean {
  if (target.closest(TEXT_ENTRY)) return true;
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    const overflow = computed(el).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollWidth > el.clientWidth) {
      return true;
    }
  }
  return false;
}
