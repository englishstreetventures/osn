/**
 * The seal's outline and the outlines of the pieces each break leaves, as
 * polygons around the seal's centre. Pieces tile the whole seal exactly, so
 * swapping the whole seal for its pieces at the moment of the break is
 * invisible.
 */

export type Point = readonly [number, number];
export type Outline = readonly Point[];

const RIM_POINTS = 72;

/** The wax's rim: a circle of radius `r` pushed in and out a little, as poured wax spreads. */
export function rim(r: number): Outline {
  const points: Point[] = [];
  for (let i = 0; i < RIM_POINTS; i++) {
    const a = (i / RIM_POINTS) * Math.PI * 2;
    const k =
      1 +
      0.04 * Math.sin(5 * a + 0.7) +
      0.025 * Math.sin(9 * a + 2.1) +
      0.015 * Math.sin(17 * a + 4);
    points.push([Math.cos(a) * r * k, Math.sin(a) * r * k]);
  }
  return points;
}

/** The same points, last first. */
function backwards(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = points.length - 1; i >= 0; i--) out.push(points[i]!);
  return out;
}

/** The rim index nearest an angle. */
function rimIndex(angle: number): number {
  const turn = angle / (Math.PI * 2);
  return ((Math.round(turn * RIM_POINTS) % RIM_POINTS) + RIM_POINTS) % RIM_POINTS;
}

/** Rim points from index `from` round to index `to`, both included, counter-clockwise. */
function arc(outline: Outline, from: number, to: number): Point[] {
  const points: Point[] = [];
  let i = from;
  for (;;) {
    points.push(outline[i]!);
    if (i === to) return points;
    i = (i + 1) % outline.length;
  }
}

/** A crack between two points, zig-zagging `amount` either side of the straight line. */
function crack(a: Point, b: Point, steps: number, amount: number): Point[] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy) || 1;
  const [nx, ny] = [-dy / length, dx / length];
  const points: Point[] = [];
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const off = amount * (s % 2 === 0 ? -1 : 1) * (0.6 + 0.4 * Math.sin(s * 2.3));
    points.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off]);
  }
  return points;
}

/** A split seal's two halves: the upper rides the flap, the lower stays on the pocket. */
interface SplitHalves {
  readonly upper: Outline;
  readonly lower: Outline;
}

/** The two halves of a seal split along the flap's edge. */
export function splitHalves(r: number): SplitHalves {
  const outline = rim(r);
  const right = 0;
  const left = RIM_POINTS / 2;
  const line = crack(outline[left]!, outline[right]!, 7, r * 0.06);
  return {
    upper: arc(outline, right, left).concat(line),
    lower: arc(outline, left, right).concat(backwards(line)),
  };
}

/** The seal crumbled into `count` wedges with jagged sides, meeting a little off centre. */
export function crumbs(r: number, count: number): Outline[] {
  const outline = rim(r);
  const centre: Point = [r * 0.08, -r * 0.05];
  const cuts = Array.from({ length: count }, (_, k) => {
    const angle = ((k + 0.3 + 0.25 * Math.sin(k * 1.7)) / count) * Math.PI * 2;
    const index = rimIndex(angle);
    return { index, line: crack(centre, outline[index]!, 4, r * 0.07) };
  });
  return cuts.map((cut, k) => {
    const next = cuts[(k + 1) % count]!;
    return [centre].concat(cut.line, arc(outline, cut.index, next.index), backwards(next.line));
  });
}

/** The centre of a polygon's points, for the direction a crumb flies. */
export function centroid(outline: Outline): Point {
  let x = 0;
  let y = 0;
  for (const [px, py] of outline) {
    x += px;
    y += py;
  }
  return [x / outline.length, y / outline.length];
}
