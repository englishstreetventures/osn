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
type SwipePanel = "details" | "rsvp";

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
 * The spring a released swipe settles on: a 0.3s response, so a natural
 * frequency of `2π / 0.3` per second, critically damped so a page lands
 * without bouncing.
 */
const SETTLE_OMEGA = (2 * Math.PI) / 0.3;
/** The spring is at rest once it is within this many px of its target… */
const REST_PX = 1;
/**
 * …and moving slower than this, in px per second. A flick about to pass its
 * target is within a pixel of it while still moving fast, and has not landed.
 */
const REST_SPEED = 30;
/** The longest a settle may run, in seconds; a critically damped spring is long at rest by then. */
const MAX_SETTLE_S = 2;
/** How far, in px, the sampled curve may stray from the spring between two stops. */
const SAMPLE_TOLERANCE_PX = 0.35;
/** The most stops a curve carries, its first and last included. */
const MAX_STOPS = 64;
/** The first stop's time, in seconds: up to here the curve is the spring's tangent at release. */
const TANGENT_S = 0.001;
/** The fallback curve's handles, fitted to the spring from rest. */
const FALLBACK_X1 = 0.17;
const FALLBACK_X2 = 0.04;

/** A released swipe's settle, as a CSS transition runs it. */
export interface SettleCurve {
  /** How long it runs, in ms at `--motion-scale` 1. */
  duration: number;
  /** The spring, sampled into a CSS `linear()` easing. */
  easing: string;
  /**
   * For an engine without `linear()` (Safari before 17.2): one
   * `cubic-bezier()` that leaves at the same speed and never passes the rest.
   */
  fallback: string;
}

/** `n` written short, to `places` decimals, with no trailing zeros. */
function short(n: number, places: number): string {
  return String(Number(n.toFixed(places)));
}

/**
 * The settle of panels released at `from` px, bound for `to`, moving at
 * `velocity` px per ms — or null when they are already there.
 *
 * A critically damped spring with a 0.3s response, started at the finger's
 * speed, which a fixed-length ease cannot: a flick carries on rather than
 * braking, and a slow release does not jump. It is sampled into `linear()`
 * stops no more than about a third of a pixel off the spring, and its first
 * stop is the spring's tangent a millisecond in, so the first frame after
 * release moves at the speed the finger had. It ends at rest, within a pixel
 * of its target and under 30px/s. A full panel's width from rest settles in
 * about 0.4s, 95% of the way by about 0.23s. A flick faster than the spring
 * can bring to rest would pass its target and come back; the curve ends where
 * it reaches the target instead, so no empty rail shows beyond the panel's
 * rest.
 */
export function settleCurve(from: number, to: number, velocity: number): SettleCurve | null {
  const distance = to - from;
  if (distance === 0) return null;
  const w = SETTLE_OMEGA;
  // Displacement from rest, x(t) − to = (d0 + b·t)·e^(−ωt), with t in seconds.
  const d0 = -distance;
  const v0 = velocity * 1000;
  const b = v0 + w * d0;
  const offset = (t: number) => (d0 + b * t) * Math.exp(-w * t);
  const speed = (t: number) => (v0 - w * b * t) * Math.exp(-w * t);
  const progress = (t: number) => 1 - offset(t) / d0;

  // It passes the target once, at −d0/b, when it is released toward it faster
  // than ω × the distance left.
  const crossing = b * d0 < 0 ? -d0 / b : Infinity;
  let end = MAX_SETTLE_S;
  for (let ms = 1; ms < MAX_SETTLE_S * 1000; ms++) {
    const t = ms / 1000;
    if (t >= crossing) {
      end = crossing;
      break;
    }
    if (Math.abs(offset(t)) <= REST_PX && Math.abs(speed(t)) <= REST_SPEED) {
      end = t;
      break;
    }
  }

  // Up to the first stop, the release speed exactly; from there, the spring,
  // halved wherever a straight line would stray past the tolerance. A curve
  // that would need more stops than the cap is sampled again more loosely.
  const first = Math.min(TANGENT_S, end / 2);
  const sample = (tolerancePx: number): [number, number][] => {
    const stops: [number, number][] = [[first, (v0 / distance) * first]];
    const tolerance = tolerancePx / Math.abs(distance);
    const refine = (a: number, pa: number, z: number, pz: number) => {
      const m = (a + z) / 2;
      const pm = progress(m);
      if (Math.abs(pm - (pa + pz) / 2) > tolerance) {
        refine(a, pa, m, pm);
        refine(m, pm, z, pz);
      } else {
        stops.push([z, pz]);
      }
    };
    refine(first, stops[0]![1], end, progress(end));
    // The last stop is the end, which the `1` after them writes: the last
    // pixel snaps there, as a spring at rest does.
    stops.pop();
    return stops;
  };
  let stops = sample(SAMPLE_TOLERANCE_PX);
  for (let loose = 2; stops.length + 2 > MAX_STOPS; loose *= 2) {
    stops = sample(SAMPLE_TOLERANCE_PX * loose);
  }
  const easing = `linear(0, ${stops
    .map(([t, p]) => `${short(p, 5)} ${short((t / end) * 100, 3)}%`)
    .join(", ")}, 1)`;

  // The same first slope, held under 1 so the curve never passes the rest.
  const slope = (v0 * end) / distance;
  const x1 = slope > 1 / FALLBACK_X1 ? 1 / slope : FALLBACK_X1;
  const fallback = `cubic-bezier(${short(x1, 4)}, ${short(slope * x1, 4)}, ${FALLBACK_X2}, 1)`;

  return { duration: end * 1000, easing, fallback };
}

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
