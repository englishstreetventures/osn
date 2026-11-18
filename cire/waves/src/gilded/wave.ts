/**
 * The Gilded wave as numbers: every quantity a frame needs, as a pure
 * function of one progress value, so a scrubbed or held frame equals a played
 * one. The front is a circle round the source; the View Transition's mask and
 * the overlay's gold band are both cut from it, so the page and the gold
 * cannot drift apart.
 *
 * The maths (anticipation, an eased front, a swell that ends with it, a rim
 * that lingers on the edges and clears later) follows Jakub Antalik's
 * Distortion Waves (MIT, `../../vendor/LICENSE`); the numbers are the ones the
 * owner approved on the builder's prototype. Lengths are canvas pixels, and
 * every length is a share of the wave's reach, so a phone and a desk read alike.
 */

/** CSS `cubic-bezier()`, solved by halving. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  return (x) => {
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      const cx = 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
      if (cx < x) lo = t;
      else hi = t;
    }
    return 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  };
}

/** GLSL's `smoothstep(a, b, x)`. */
export function smooth(a: number, b: number, x: number): number {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
}

const FRONT_EASE = bezier(0.22, 1, 0.36, 1);
const RIM_EASE = bezier(0.42, 0, 0.58, 1);

/** The wave's timings, in seconds, and its dust. */
const PHASES = {
  anticipation: 0.42,
  travel: 1.9,
  linger: -0.3,
  rimFade: 2.0,
  hairLinger: 0.45,
  hairFade: 1.9,
  dustLife: 1.9,
  dust: 64,
} as const;

export const WAVE = {
  ...PHASES,
  /** The whole run: the anticipation, then the longest of what follows it. */
  duration:
    PHASES.anticipation +
    Math.max(
      PHASES.travel * 0.6,
      PHASES.linger + PHASES.rimFade,
      PHASES.linger + PHASES.hairLinger + PHASES.hairFade,
      PHASES.dustLife,
    ),
} as const;

/** Where a wave runs, in the overlay canvas's device pixels. */
export interface Stage {
  /** The canvas. */
  readonly W: number;
  readonly H: number;
  /** Where the frame starts below the canvas's top; above it is the bar. */
  readonly vTop: number;
  /** Device pixels per CSS pixel. */
  readonly dpr: number;
  /** The wave's centre: the source, leaned toward where it was pressed. */
  readonly src: readonly [number, number];
  /** The lean, in radians. */
  readonly tilt: number;
}

export interface WaveFrame {
  /** Seconds into the run, and since the front left. */
  readonly t: number;
  readonly since: number;
  /** 0–1: the dust gathered round the source before the front leaves. */
  readonly gathered: number;
  /** The front's radius, and the distance it must cover. */
  readonly radius: number;
  readonly reach: number;
  readonly launchR: number;
  readonly swell: number;
  readonly band: number;
  readonly rimOn: number;
  /** Where the rim and the hairline have cleared to. */
  readonly clearR: number;
  readonly hairR: number;
}

/** The farthest corner of the frame from the source, the front's reach. */
function farthest(s: Stage): number {
  const [sx, sy] = s.src;
  const corners: [number, number][] = [
    [0, s.vTop],
    [s.W, s.vTop],
    [0, s.H],
    [s.W, s.H],
  ];
  return Math.max(...corners.map(([cx, cy]) => Math.hypot(cx - sx, cy - sy)));
}

/** The whole wave at progress `p` (0–1). */
export function waveAt(s: Stage, p: number): WaveFrame {
  const t = Math.min(Math.max(p, 0), 1) * WAVE.duration;
  const since = t - WAVE.anticipation;
  const gathered = smooth(0, WAVE.anticipation, t);
  const x = Math.min(Math.max(since / WAVE.travel, 0), 1);
  const moved = FRONT_EASE(x);
  const reach = farthest(s) / 0.92;
  // The front overshoots the far corner by the mask's feather and the swell's
  // bend, so the whole frame is behind it before it stops.
  const launchR = 14 * s.dpr;
  const over = 0.09 * reach;
  const cover = 0.22 * reach;
  const radius =
    since < 0
      ? launchR * (0.4 + 0.6 * (1 - gathered))
      : launchR + (reach + cover + over - launchR) * moved;
  const fin = 1 - smooth(0.9, 1, t / WAVE.duration);
  const clearAt = (lag: number, fade: number) =>
    launchR + (reach + over) * RIM_EASE(Math.min(Math.max((since - lag) / fade, 0), 1));
  return {
    t,
    since,
    gathered,
    radius,
    reach,
    launchR,
    swell: 0.02 * reach * smooth(0, 0.3, moved),
    // The colour is there as soon as the front moves: the ease-out covers
    // ground early.
    band: since < 0 ? gathered * 0.33 : (0.33 + 0.67 * smooth(0, 0.015, x)) * fin,
    rimOn: smooth(0, 0.02, x) * fin,
    clearR: clearAt(WAVE.linger, WAVE.rimFade),
    hairR: clearAt(WAVE.linger + WAVE.hairLinger, WAVE.hairFade),
  };
}

/** The View Transition's mask at `p`: a circle on the front, opaque `inner`
 *  behind it and clear `outer` ahead of it. Canvas pixels. */
export interface Cut {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly inner: number;
  readonly outer: number;
}

export function maskAt(s: Stage, p: number): Cut {
  const w = waveAt(s, p);
  return { x: s.src[0], y: s.src[1], r: w.radius, inner: 0.035 * w.reach, outer: 0.05 * w.reach };
}

/** The first progress at which the mask has uncovered the whole frame: the
 *  transition holds that long, and the live page is the new view from then on. */
export function handoverAt(s: Stage): number {
  const far = farthest(s);
  const done = (p: number) => {
    const m = maskAt(s, p);
    return m.r - m.inner >= far;
  };
  if (!done(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (done(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The dust at `w`: `WAVE.dust` points as x, y, alpha and size, written into
 * `out`. It gathers round the source while the wave winds up, then flies out
 * behind the front and fades.
 */
export function dustAt(s: Stage, w: WaveFrame, out: Float32Array): Float32Array {
  const [sx, sy] = s.src;
  const head = Math.atan2(s.H * 0.6 - sy, s.W * 0.45 - sx);
  for (let i = 0; i < WAVE.dust; i++) {
    const h1 = (i * 0.6180339) % 1;
    const h2 = (i * 0.7548777) % 1;
    const h3 = (i * 0.5698403) % 1;
    const ang = head + (h1 - 0.5) * Math.PI * 1.25 + s.tilt * 0.8;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const r0 = (34 + 64 * h2) * s.dpr;
    const hops = w.t / (0.2 + 0.12 * h3) + h2;
    const along = hops % 1;
    const hop = smooth(0, 0.25, along) * (1 - smooth(0.55, 1, along));
    const fly = Math.max(w.since, 0);
    const life = WAVE.dustLife * (0.6 + 0.4 * h3);
    const gatherDist = r0 * (1 - 0.6 * w.gathered) - hop * 5 * s.dpr;
    const flyDist = w.launchR + (w.radius - w.launchR) * (0.45 + 0.5 * h2);
    const dist =
      w.since < 0 ? gatherDist : gatherDist + (flyDist - gatherDist) * smooth(0, 0.35, fly);
    const sway = Math.sin(fly * 4 + h1 * 6.28) * 9 * s.dpr * smooth(0, 0.3, fly);
    const alpha =
      (w.since < 0 ? w.gathered : 1) * (0.45 + 0.55 * h3) * (1 - smooth(life * 0.55, life, fly));
    out[i * 4] = sx + dx * dist - dy * sway;
    out[i * 4 + 1] = sy + dy * dist + dx * sway;
    out[i * 4 + 2] = alpha;
    out[i * 4 + 3] = (2.2 + 2.2 * h1) * s.dpr;
  }
  return out;
}
