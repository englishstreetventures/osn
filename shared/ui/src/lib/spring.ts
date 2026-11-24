/**
 * The physics a hand-built gesture hands its release to: UIKit's rubber band
 * past an edge, and a critically damped spring started at the finger's speed,
 * sampled into a CSS `linear()` easing so a transition can run it.
 *
 * `@shared/ui`'s `Dialog` sheet settles a drag on it, and cire's guest-site
 * event sheet settles a swipe between its panels on it
 * (`wiki/shared/frontend-patterns.md`, "A gesture follows the finger").
 */

/** How much of a finger's travel past an edge a touch moves the view at first. */
const BAND_COEFFICIENT = 0.55;

/**
 * How far a view moves for a finger `x` past its edge, on a view `d` long:
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
 * How fast the view moves per unit of finger at `x` past the edge — the
 * rubber band's slope, `c / (1 + c·|x|/d)²`. A release from the band hands
 * the spring the view's speed, which is this share of the finger's.
 */
export function bandSlope(x: number, d: number, c = BAND_COEFFICIENT): number {
  return c / (1 + (c * Math.abs(x)) / d) ** 2;
}

/**
 * The spring a release settles on: a 0.3s response, so a natural frequency of
 * `2π / 0.3` per second, critically damped so it lands without bouncing.
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
/**
 * How far, in px, the sampled curve may stray from the spring at each place
 * between two stops that {@link PROBES} names.
 */
const SAMPLE_TOLERANCE_PX = 0.35;
/**
 * Where between two stops the curve is checked against the spring, as shares
 * of the gap. The midpoint alone is not enough: a stretch over a dip, or over
 * the bend from speeding up to slowing down, can sit on its chord there.
 */
const PROBES = [0.25, 0.5, 0.75];
/**
 * The shortest gap between two stops, in seconds: far under a frame, so the
 * sampler stops halving there even where the spring bends faster than the
 * tolerance allows, as it does in the first millisecond of a very fast release.
 */
const MIN_GAP_S = 0.0005;
/** The most stops a curve carries, its first and last included. */
const MAX_STOPS = 64;
/** The first stop's time, in seconds: up to here the curve is the spring's tangent at release. */
const TANGENT_S = 0.001;
/** The fallback curve's handles, fitted to the spring from rest. */
const FALLBACK_X1 = 0.17;
const FALLBACK_X2 = 0.04;

/** A release's settle, as a CSS transition runs it. */
export interface SettleCurve {
  /** How long it runs, in ms. */
  duration: number;
  /** The spring, sampled into a CSS `linear()` easing. */
  easing: string;
  /**
   * For an engine without `linear()` (Chrome before 113, Safari before
   * 17.2): one `cubic-bezier()` that leaves at the same speed, never passes
   * the rest, and runs no further the wrong way than the spring.
   */
  fallback: string;
}

/** `n` written short, to `places` decimals, with no trailing zeros. */
function short(n: number, places: number): string {
  return String(Number(n.toFixed(places)));
}

/**
 * The lowest `y1` a `cubic-bezier(x1, y1, x2, 1)` may take without its
 * progress dipping below `floor` (a value under 0). Its progress at parameter
 * `s` is `y1·3s(1 − s)² + s²(3 − 2s)`, which falls as `y1` does, so the
 * lowest `y1` is the largest value `(floor − s²(3 − 2s)) / 3s(1 − s)²` takes.
 */
function lowestY1(floor: number): number {
  let y1 = -Infinity;
  for (let i = 1; i < 1000; i++) {
    const s = i / 1000;
    y1 = Math.max(y1, (floor - s * s * (3 - 2 * s)) / (3 * s * (1 - s) ** 2));
  }
  return y1;
}

/** How a settle may end sooner than at rest. */
export interface SettleOptions {
  /**
   * End the curve the first millisecond the spring is within this many px of
   * its target, however fast it still moves; the last of it snaps there. A
   * sheet leaving the screen ends this way, since nobody watches its last few
   * pixels go.
   */
  endWithinPx?: number;
}

/**
 * The settle of something released at `from` px, bound for `to`, moving at
 * `velocity` px per ms — or null when it is already there.
 *
 * A critically damped spring with a 0.3s response, started at the finger's
 * speed, which a fixed-length ease cannot: a flick carries on rather than
 * braking, and a slow release does not jump. It is sampled into `linear()`
 * stops that keep it under 0.4px off the spring from any release a finger
 * makes (up to 10px/ms), and its first stop is the spring's tangent a
 * millisecond in, so the first frame after release moves at the speed the
 * finger had. A release far faster strays further, since that tangent alone
 * does, and so does a curve that would need more than 64 stops, which is
 * sampled again more loosely. It ends at rest, within a pixel of its target
 * and under 30px/s, or with `endWithinPx` once that close. A full 366px from
 * rest settles in about 0.4s, 95% of the
 * way by about 0.23s. A flick faster than the spring can bring to rest would
 * pass its target and come back; the curve ends where it reaches the target
 * instead, so nothing shows beyond the rest.
 */
export function settleCurve(
  from: number,
  to: number,
  velocity: number,
  options: SettleOptions = {},
): SettleCurve | null {
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
    const left = Math.abs(offset(t));
    if (options.endWithinPx !== undefined && left <= options.endWithinPx) {
      end = t;
      break;
    }
    if (left <= REST_PX && Math.abs(speed(t)) <= REST_SPEED) {
      end = t;
      break;
    }
  }

  // Up to the first stop, the release speed exactly; from there, the spring,
  // halved wherever a straight line would stray past the tolerance at any
  // probe, down to the shortest gap. A curve that would need more stops than
  // the cap is sampled again more loosely.
  const first = Math.min(TANGENT_S, end / 2);
  const sample = (tolerancePx: number): [number, number][] => {
    const stops: [number, number][] = [[first, (v0 / distance) * first]];
    const tolerance = tolerancePx / Math.abs(distance);
    const refine = (a: number, pa: number, z: number, pz: number) => {
      const strays = PROBES.some(
        (u) => Math.abs(progress(a + (z - a) * u) - (pa + (pz - pa) * u)) > tolerance,
      );
      if (strays && z - a > MIN_GAP_S) {
        const m = (a + z) / 2;
        const pm = progress(m);
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
  // Released moving away from the rest, the slope is negative and the curve
  // runs the wrong way first; there the handle shortens, where it must, so
  // the curve goes no further that way than the spring does, at its turn
  // (t = 1/ω − d0/b, where its speed is 0).
  const slope = (v0 * end) / distance;
  let x1 = slope > 1 / FALLBACK_X1 ? 1 / slope : FALLBACK_X1;
  if (slope < 0) x1 = Math.min(x1, lowestY1(progress(1 / w - d0 / b)) / slope);
  const fallback = `cubic-bezier(${short(x1, 4)}, ${short(slope * x1, 4)}, ${FALLBACK_X2}, 1)`;

  return { duration: end * 1000, easing, fallback };
}

/**
 * Whether this engine reads a `linear()` easing; Chrome before 113 and Safari
 * before 17.2 do not. Asked when a settle starts, never at import, so a
 * server render that imports this module reads no `CSS`.
 */
export function readsLinearEasing(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("transition-timing-function", "linear(0, 1)")
  );
}
