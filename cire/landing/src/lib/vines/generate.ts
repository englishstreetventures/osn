// Procedural vine generator. Pure + deterministic: given a seed and a canvas
// size it returns the SVG geometry for a field of botanical vines that emerge
// from the left/right edges, meander down and inward, throw off a few sparse
// branches, curl into tendrils at their tips, and carry phyllotactic leaves +
// the occasional flower. Same seed ⇒ same field (so roots can be prerendered and
// the client can regrow an identical or, with a fresh seed, a new plant).
//
// Technique notes (from research): stems are a turtle-walk with layered
// sine+brownian curvature, smoothed to a C1 cubic-Bézier via Catmull-Rom;
// tendrils are capped logarithmic spirals; organs are placed by the golden
// angle; branching is depth- and budget-limited so it never becomes a bush.
// Stems are STROKED (not filled ribbons) so the draw-on growth animation
// (stroke-dashoffset) works — see VineCanvas.

import { len as vlen, smoothPath, sub, vec, type Vec } from "./geometry";
import { makeRng, type Rng } from "./prng";

export interface Root {
  x: number;
  y: number;
  /** Heading in radians (PI/2 = straight down in SVG coords). */
  heading: number;
  /** -1 = left edge (drifts right), +1 = right edge (drifts left). */
  side: -1 | 1;
}

export interface Strand {
  /** Smooth stroked path data. */
  d: string;
  /**
   * Normalized [0,1] positions within the vine's vertical span where this
   * strand's drawing starts (a0) and finishes (a1). Keyed to the SAME growth
   * front (`--p`) as everything else, so a tendril only draws once the stem has
   * reached its attachment point — and recedes with it on scroll-up.
   */
  a0: number;
  a1: number;
}

export interface Leaf {
  /** Filled almond path data. */
  d: string;
  /** Normalized [0,1] position within the vine's span at which the leaf reveals. */
  a: number;
}

export interface Flower {
  petals: string[];
  cx: number;
  cy: number;
  cr: number;
  /** Normalized [0,1] reveal position within the vine's span. */
  a: number;
}

export interface Vine {
  /** Stroked stem + branch + tendril paths, in draw order (base → tip). */
  strands: Strand[];
  leaves: Leaf[];
  flowers: Flower[];
  /** Vertical span in canvas px — drives the scroll-linked growth mapping. */
  top: number;
  bottom: number;
}

export interface VineField {
  width: number;
  height: number;
  seed: string;
  roots: Root[];
  vines: Vine[];
}

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Irwin–Hall gaussian-ish noise in roughly [-1, 1] for natural jitter. */
function gauss(r: Rng): number {
  return (r.next() + r.next() + r.next() + r.next() + r.next() + r.next() - 3) / 1.5;
}

interface StemOpts {
  start: Vec;
  heading: number;
  steps: number;
  stepLen: number;
  curl: number;
  wander: number;
  inwardBias: number;
  gravity: number;
  side: -1 | 1;
  maxY: number;
  /** Per-anchor chance of throwing a curling tendril off the stem mid-length. */
  tendrilRate: number;
}

/** Turtle-walk a sinuous stem, returning its anchor polyline. */
function growStem(r: Rng, o: StemOpts): Vec[] {
  const pts: Vec[] = [{ ...o.start }];
  let x = o.start.x;
  let y = o.start.y;
  let h = o.heading;
  const phase = r.range(0, TAU);
  const freq = r.range(0.18, 0.34);

  for (let i = 1; i <= o.steps; i++) {
    const along = (i - 1) / o.steps;
    h += Math.sin(phase + i * freq) * o.curl; // coherent S-curve spine
    h += gauss(r) * o.wander; // organic irregularity
    // Sweep inward, strongest near the root and easing off — so the vine arcs
    // into the page rather than hugging the edge straight down.
    h += o.side * o.inwardBias * (1 - along);
    h += (Math.PI / 2 - h) * o.gravity; // ease toward straight-down
    const step = o.stepLen * r.range(0.85, 1.15);
    x += Math.cos(h) * step;
    y += Math.sin(h) * step;
    pts.push(vec(x, y));
    if (y > o.maxY) break; // never run far past the page bottom
  }
  return pts;
}

/** A capped logarithmic-spiral tendril leaving `origin` along `tangent`. */
function tendril(r: Rng, origin: Vec, tangent: number, dir: -1 | 1): Vec[] {
  const turns = r.range(0.8, 1.7);
  const startR = r.range(12, 34);
  const tightness = r.range(0.12, 0.22);
  const steps = Math.max(12, Math.round(turns * 16));
  const total = turns * TAU;
  const baseAng = tangent + (dir * Math.PI) / 2;
  const cx = origin.x + Math.cos(baseAng) * startR;
  const cy = origin.y + Math.sin(baseAng) * startR;

  const pts: Vec[] = [origin];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * total;
    const rad = startR * Math.exp(-tightness * t); // shrink inward → tight tip
    const ang = baseAng + Math.PI + dir * t;
    pts.push(vec(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad));
  }
  return pts;
}

/** Cumulative-arc-length frame (position + unit tangent) at fraction `s`. */
function arcFrame(pts: Vec[], s: number): { pos: Vec; tan: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + vlen(sub(pts[i]!, pts[i - 1]!)));
  const total = cum[cum.length - 1]!;
  if (total === 0) return { pos: pts[0]!, tan: Math.PI / 2 };
  const target = s * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < target) i++;
  const seg = cum[i]! - cum[i - 1]! || 1;
  const t = (target - cum[i - 1]!) / seg;
  const a = pts[i - 1]!;
  const b = pts[i]!;
  return {
    pos: vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
    tan: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** Filled almond leaf at `at`, pointing along `ang`, length `len`. */
function leafPath(at: Vec, ang: number, len: number): string {
  const width = len * 0.42;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const T = (px: number, py: number): Vec => vec(at.x + px * c - py * s, at.y + px * s + py * c);
  const f = (p: Vec) => `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`;
  const base = T(0, 0);
  const tip = T(len, 0);
  return (
    `M ${f(base)} C ${f(T(len * 0.12, width * 0.5))} ${f(T(len * 0.78, width * 0.32))} ${f(tip)}` +
    ` C ${f(T(len * 0.78, -width * 0.32))} ${f(T(len * 0.12, -width * 0.5))} ${f(base)} Z`
  );
}

/** Golden-angle leaves (alternating sides) + an occasional tip flower. */
function placeOrgans(r: Rng, stem: Vec[], leaves: Leaf[], flowers: Flower[], wantFlower: boolean) {
  const n = r.int(4, 7);
  const s0 = r.range(0.14, 0.24);
  let phi = r.range(0, TAU);
  for (let k = 0; k < n; k++) {
    phi += GOLDEN_ANGLE;
    const s = clamp(s0 + (0.96 - s0) * (k / Math.max(1, n - 1)) + gauss(r) * 0.02, 0.05, 0.97);
    const f = arcFrame(stem, s);
    const side: -1 | 1 = Math.sin(phi) >= 0 ? 1 : -1;
    const pitch = r.range(0.35, 0.6);
    const ang = f.tan + side * (Math.PI / 2 - pitch); // outward, leaning to tip
    const leafLen = r.range(22, 40) * (1 - 0.3 * (k / n));
    // `a` temporarily holds the raw y; normalised to [0,1] in generateVine.
    leaves.push({ d: leafPath(f.pos, ang, leafLen), a: f.pos.y });
  }
  if (wantFlower && r.chance(0.75)) {
    const f = arcFrame(stem, r.range(0.86, 0.97));
    const R = r.range(6, 10);
    const rot = r.range(0, TAU);
    const petals: string[] = [];
    for (let i = 0; i < 5; i++) {
      petals.push(leafPath(f.pos, rot + (i * TAU) / 5, R));
    }
    flowers.push({ petals, cx: f.pos.x, cy: f.pos.y, cr: R * 0.3, a: f.pos.y });
  }
}

interface Budget {
  n: number;
}

/**
 * Smooth a polyline into a stroked strand and record its raw y-extent in
 * a0/a1 (normalised later) so its draw-on stays locked to the growth front.
 */
function pushStrand(out: Vine, pts: Vec[]) {
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of pts) {
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  if (top < out.top) out.top = top;
  if (bottom > out.bottom) out.bottom = bottom;
  out.strands.push({ d: smoothPath(pts), a0: top, a1: bottom });
}

/** Recursively build a stem + its sparse branches, tendrils and organs. */
function buildBranch(r: Rng, o: StemOpts, depth: number, budget: Budget, out: Vine) {
  const stem = growStem(r, o);
  pushStrand(out, stem);

  // Tendril curl at the tip (chirality alternates via a coin per call).
  if (stem.length >= 2 && r.chance(depth === 0 ? 0.92 : 0.6)) {
    const a = stem[stem.length - 2]!;
    const b = stem[stem.length - 1]!;
    const tan = Math.atan2(b.y - a.y, b.x - a.x);
    pushStrand(out, tendril(r, b, tan, r.chance(0.5) ? 1 : -1));
  }

  // Mid-stem tendril curls — these give the vine a curlier character than a
  // stem that just flows down. Spaced out and capped so it stays graceful.
  let curls = 0;
  for (let i = 2; i < stem.length - 2 && curls < 3; i++) {
    if (!r.chance(o.tendrilRate)) continue;
    const a = stem[i - 1]!;
    const b = stem[i + 1]!;
    const tan = Math.atan2(b.y - a.y, b.x - a.x);
    pushStrand(out, tendril(r, stem[i]!, tan, r.chance(0.5) ? 1 : -1));
    curls++;
    i += 1;
  }

  placeOrgans(r, stem, out.leaves, out.flowers, depth <= 1);

  if (depth >= 2) return;
  let side: -1 | 1 = r.chance(0.5) ? 1 : -1;
  let lastBranch = -3;
  for (let i = 2; i < stem.length - 1; i++) {
    if (budget.n <= 0) break;
    if (i - lastBranch < 3) continue;
    const along = i / stem.length;
    const p = 0.18 * (1 - 0.5 * along) * (1 - depth * 0.4);
    if (!r.chance(p)) continue;
    lastBranch = i;
    budget.n--;
    side = (side * -1) as -1 | 1;
    const a = stem[i - 1]!;
    const b = stem[i + 1]!;
    const tan = Math.atan2(b.y - a.y, b.x - a.x);
    buildBranch(
      r,
      {
        ...o,
        start: stem[i]!,
        heading: tan + side * r.range(0.45, 0.85),
        steps: Math.max(4, Math.round(o.steps * 0.6)),
        stepLen: o.stepLen * 0.62,
        curl: o.curl * 1.1,
      },
      depth + 1,
      budget,
      out,
    );
  }
}

/** Deterministic root anchors down both edges — the "where vines come from". */
export function computeRoots(width: number, height: number, r: Rng): Root[] {
  // Denser than before so the page feels generously planted.
  const count = clamp(Math.round(height / 360), 6, 13);
  const roots: Root[] = [];
  let side: -1 | 1 = r.chance(0.5) ? 1 : -1;
  for (let k = 0; k < count; k++) {
    const yFrac = (k + 0.5 + r.jitter(0.42)) / count;
    const y = clamp(height * (0.02 + 0.94 * yFrac), 0, height);
    const x = side < 0 ? r.range(-34, 36) : width - r.range(-34, 36);
    // Wide heading spread: some dive down, some strike out almost horizontally
    // into the page — the source of much of the directional variety.
    roots.push({ x, y, side, heading: Math.PI / 2 + side * r.range(0.18, 1.0) });
    // Mostly alternate edges, but occasionally repeat a side so the rhythm
    // isn't perfectly regular.
    if (r.chance(0.8)) side = (side * -1) as -1 | 1;
  }
  return roots;
}

/**
 * Growth archetypes — each vine picks one, which is the main lever for "lots of
 * variation in shape and direction". Tuples are [min, max] ranges.
 */
const STYLES = [
  // Sweeper — long, confident arc striking deep into the page, gentle curl.
  {
    stepLen: [88, 122],
    curl: [0.07, 0.13],
    wander: [0.04, 0.07],
    inward: [0.04, 0.08],
    gravity: [0.015, 0.03],
    branches: [2, 4],
    tendril: [0.05, 0.1],
  },
  // Curler — short, tightly looping, low gravity so it coils rather than falls.
  {
    stepLen: [42, 66],
    curl: [0.24, 0.42],
    wander: [0.07, 0.12],
    inward: [0.02, 0.05],
    gravity: [0.004, 0.014],
    branches: [3, 6],
    tendril: [0.16, 0.26],
  },
  // Climber — medium, balanced, a steady inward drift with regular curl.
  {
    stepLen: [62, 92],
    curl: [0.13, 0.22],
    wander: [0.05, 0.09],
    inward: [0.03, 0.065],
    gravity: [0.012, 0.026],
    branches: [3, 5],
    tendril: [0.09, 0.17],
  },
  // Wanderer — wide, unpredictable swings; the loosest, most organic shape.
  {
    stepLen: [56, 90],
    curl: [0.16, 0.3],
    wander: [0.1, 0.16],
    inward: [0.012, 0.045],
    gravity: [0.005, 0.016],
    branches: [2, 5],
    tendril: [0.11, 0.2],
  },
] as const;

/** Generate one vine from a root anchor, picking a random growth style. */
export function generateVine(r: Rng, root: Root, width: number, height: number): Vine {
  const out: Vine = { strands: [], leaves: [], flowers: [], top: Infinity, bottom: -Infinity };
  const s = r.pick(STYLES);
  const stepLen = r.range(s.stepLen[0], s.stepLen[1]);
  const steps = clamp(Math.round((height - root.y) / stepLen) + r.int(2, 6), 8, 26);
  buildBranch(
    r,
    {
      start: vec(root.x, root.y),
      heading: root.heading,
      steps,
      stepLen,
      curl: r.range(s.curl[0], s.curl[1]),
      wander: r.range(s.wander[0], s.wander[1]),
      inwardBias: r.range(s.inward[0], s.inward[1]),
      gravity: r.range(s.gravity[0], s.gravity[1]),
      side: root.side,
      maxY: height + 140,
      tendrilRate: r.range(s.tendril[0], s.tendril[1]),
    },
    0,
    { n: r.int(s.branches[0], s.branches[1]) },
    out,
  );

  // Normalise every element's raw y into a [0,1] reveal position within the
  // vine's span, so strokes, tendrils, leaves and flowers all draw/recede in
  // lockstep with the single growth front (`--p`). A small minimum window keeps
  // near-horizontal strands from dividing by zero.
  const span = Math.max(1, out.bottom - out.top);
  for (const st of out.strands) {
    // Cap the start a touch below 1 so every strand still has room to finish
    // drawing by the time the front reaches the bottom of the vine.
    const a0 = clamp((st.a0 - out.top) / span, 0, 0.97);
    const t1 = clamp((st.a1 - out.top) / span, 0, 1);
    st.a0 = a0;
    st.a1 = Math.min(1, Math.max(t1, a0 + 0.03));
  }
  for (const leaf of out.leaves) leaf.a = clamp((leaf.a - out.top) / span, 0, 1);
  for (const flower of out.flowers) flower.a = clamp((flower.a - out.top) / span, 0, 1);
  return out;
}

/**
 * Generate a full field. `width`/`height` are the canvas (document) size in px.
 * Each vine gets its own salted RNG stream so one can change without disturbing
 * the others, and so roots stay stable while growth varies.
 */
export function generateField(seed: string, width: number, height: number): VineField {
  const roots = computeRoots(width, height, makeRng(`${seed}::roots`));
  const vines = roots.map((root, i) =>
    generateVine(makeRng(`${seed}::vine:${i}`), root, width, height),
  );
  return { width, height, seed, roots, vines };
}
