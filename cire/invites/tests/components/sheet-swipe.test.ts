import { describe, expect, it } from "vitest";

import {
  bandOffset,
  bandSlope,
  beginsBand,
  beginsDrag,
  clampOffset,
  pastSlop,
  rubberBand,
  settleCurve,
  shouldCommit,
  startsInside,
  velocityOf,
} from "../../src/components/sheet-swipe";

const WIDTH = 400;

describe("beginsDrag", () => {
  it("refuses a move that is mostly vertical", () => {
    expect(beginsDrag({ dx: -20, dy: 30, panel: "details" })).toBe(false);
  });

  it("refuses a move toward the side with no panel", () => {
    // Details is the start-side panel: nothing lies to its left.
    expect(beginsDrag({ dx: 40, dy: 0, panel: "details" })).toBe(false);
    expect(beginsDrag({ dx: -40, dy: 0, panel: "rsvp" })).toBe(false);
  });

  it("refuses a move exactly as wide as it is tall", () => {
    expect(beginsDrag({ dx: -20, dy: 20, panel: "details" })).toBe(false);
  });

  it("refuses a move still inside the slop", () => {
    expect(beginsDrag({ dx: -10, dy: 0, panel: "details" })).toBe(false);
  });

  it("begins a horizontal move toward the other panel", () => {
    expect(beginsDrag({ dx: -11, dy: 2, panel: "details" })).toBe(true);
    expect(beginsDrag({ dx: 11, dy: -2, panel: "rsvp" })).toBe(true);
  });
});

describe("pastSlop", () => {
  it("waits while the touch stays within 10px both ways", () => {
    expect(pastSlop(10, -10)).toBe(false);
  });

  it("decides once the touch leaves the slop in either axis", () => {
    expect(pastSlop(0, 11)).toBe(true);
    expect(pastSlop(-11, 0)).toBe(true);
  });
});

describe("rubberBand", () => {
  it("is 0 at the edge and odd about it", () => {
    expect(rubberBand(0, 390)).toBe(0);
    expect(rubberBand(-100, 390)).toBeCloseTo(-rubberBand(100, 390), 10);
  });

  it("moves 0.55·x·d / (d + 0.55·x) for a touch", () => {
    expect(rubberBand(100, 390)).toBeCloseTo((0.55 * 100 * 390) / (390 + 55), 10);
  });

  it("moves less than the finger, and never as far as the view", () => {
    for (const x of [1, 50, 390, 5000, 1e9]) {
      expect(rubberBand(x, 390)).toBeLessThan(x);
      expect(rubberBand(x, 390)).toBeLessThan(390);
    }
  });
});

describe("bandSlope", () => {
  it("is the coefficient at the edge, and falls with distance", () => {
    expect(bandSlope(0, 390)).toBeCloseTo(0.55, 10);
    expect(bandSlope(100, 390)).toBeLessThan(bandSlope(10, 390));
    expect(bandSlope(-100, 390)).toBeCloseTo(bandSlope(100, 390), 10);
    expect(bandSlope(1e6, 390)).toBeGreaterThan(0);
  });

  it("is c / (1 + c·x/d)²", () => {
    expect(bandSlope(100, 390)).toBeCloseTo(0.55 / (1 + 55 / 390) ** 2, 10);
  });
});

describe("clampOffset", () => {
  it("damps a reversal past the start, on the side with no panel", () => {
    expect(clampOffset(80, "details", WIDTH)).toBeCloseTo(rubberBand(80, WIDTH), 10);
    expect(clampOffset(80, "details", WIDTH)).toBeGreaterThan(0);
    expect(clampOffset(-80, "rsvp", WIDTH)).toBeCloseTo(rubberBand(-80, WIDTH), 10);
    expect(clampOffset(-80, "rsvp", WIDTH)).toBeLessThan(0);
  });

  it("damps a drag past the other panel's resting place", () => {
    expect(clampOffset(-WIDTH - 120, "details", WIDTH)).toBeCloseTo(
      -WIDTH - rubberBand(120, WIDTH),
      10,
    );
    expect(clampOffset(WIDTH + 120, "rsvp", WIDTH)).toBeCloseTo(WIDTH + rubberBand(120, WIDTH), 10);
    expect(Math.abs(clampOffset(-WIDTH - 120, "details", WIDTH))).toBeLessThan(WIDTH + 120);
  });

  it("passes an offset inside both bounds through", () => {
    expect(clampOffset(-120, "details", WIDTH)).toBe(-120);
    expect(clampOffset(120, "rsvp", WIDTH)).toBe(120);
  });
});

describe("bandOffset", () => {
  it("damps a move toward the side with no panel", () => {
    expect(bandOffset(80, "details", WIDTH)).toBeCloseTo(rubberBand(80, WIDTH), 10);
    expect(bandOffset(-80, "rsvp", WIDTH)).toBeCloseTo(rubberBand(-80, WIDTH), 10);
  });

  it("stops at 0 when the finger comes back past where it started", () => {
    expect(bandOffset(-120, "details", WIDTH)).toBe(0);
    expect(bandOffset(120, "rsvp", WIDTH)).toBe(0);
  });
});

describe("beginsBand", () => {
  it("begins for a horizontal move toward the side with no panel", () => {
    expect(beginsBand({ dx: 30, dy: 4, panel: "details" })).toBe(true);
    expect(beginsBand({ dx: -30, dy: 4, panel: "rsvp" })).toBe(true);
  });

  it("refuses a vertical move, a move toward the other panel, and one inside the slop", () => {
    expect(beginsBand({ dx: 12, dy: 40, panel: "details" })).toBe(false);
    expect(beginsBand({ dx: -30, dy: 4, panel: "details" })).toBe(false);
    expect(beginsBand({ dx: 8, dy: 0, panel: "details" })).toBe(false);
  });

  it("refuses a move of exactly the slop, and one exactly as wide as it is tall", () => {
    expect(beginsBand({ dx: 10, dy: 0, panel: "details" })).toBe(false);
    expect(beginsBand({ dx: 30, dy: 30, panel: "details" })).toBe(false);
  });
});

describe("shouldCommit", () => {
  it("springs back from a slow, short drag", () => {
    expect(shouldCommit({ dx: -60, velocity: -0.06, width: WIDTH, panel: "details" })).toBe(false);
  });

  it("commits a drag past three tenths of the width, however slow", () => {
    expect(shouldCommit({ dx: -121, velocity: 0, width: WIDTH, panel: "details" })).toBe(true);
    expect(shouldCommit({ dx: 121, velocity: 0, width: WIDTH, panel: "rsvp" })).toBe(true);
  });

  it("springs back from a drag of exactly three tenths", () => {
    expect(shouldCommit({ dx: -120, velocity: 0, width: WIDTH, panel: "details" })).toBe(false);
  });

  it("commits a fast flick toward the other panel", () => {
    expect(shouldCommit({ dx: -40, velocity: -0.5, width: WIDTH, panel: "details" })).toBe(true);
  });

  it("springs back from a flick under 24px, however fast", () => {
    expect(shouldCommit({ dx: -20, velocity: -2, width: WIDTH, panel: "details" })).toBe(false);
    expect(shouldCommit({ dx: -24, velocity: -2, width: WIDTH, panel: "details" })).toBe(false);
  });

  it("springs back from a drag on the side with no panel, however fast or far", () => {
    expect(shouldCommit({ dx: 200, velocity: 5, width: WIDTH, panel: "details" })).toBe(false);
    expect(shouldCommit({ dx: -200, velocity: -5, width: WIDTH, panel: "rsvp" })).toBe(false);
  });

  it("springs back from a flick at exactly the flick speed", () => {
    expect(shouldCommit({ dx: -40, velocity: -0.35, width: WIDTH, panel: "details" })).toBe(false);
    expect(shouldCommit({ dx: 40, velocity: 0.35, width: WIDTH, panel: "rsvp" })).toBe(false);
    expect(shouldCommit({ dx: 40, velocity: 0.36, width: WIDTH, panel: "rsvp" })).toBe(true);
  });

  it("springs back from a flick that turned back the other way", () => {
    expect(shouldCommit({ dx: -60, velocity: 0.5, width: WIDTH, panel: "details" })).toBe(false);
  });
});

describe("velocityOf", () => {
  it("measures px per ms over the last 100ms only", () => {
    const samples = [
      { x: 0, t: 0 }, // older than the window: ignored
      { x: -10, t: 400 },
      { x: -60, t: 500 },
    ];
    expect(velocityOf(samples)).toBeCloseTo(-0.5);
  });

  it("is zero with fewer than two samples in the window", () => {
    expect(velocityOf([{ x: 0, t: 0 }])).toBe(0);
    expect(velocityOf([])).toBe(0);
    expect(
      velocityOf([
        { x: 0, t: 0 },
        { x: -50, t: 300 },
      ]),
    ).toBe(0);
  });

  it("measures two samples inside the window", () => {
    expect(
      velocityOf([
        { x: 0, t: 0 },
        { x: -50, t: 100 },
      ]),
    ).toBeCloseTo(-0.5);
  });

  it("is zero, not infinite, for two samples at one instant", () => {
    expect(
      velocityOf([
        { x: 0, t: 10 },
        { x: -50, t: 10 },
      ]),
    ).toBe(0);
  });
});

describe("startsInside", () => {
  /** A computed-style stub keyed by element, so jsdom's missing layout is not consulted. */
  function styles(map: Map<Element, string>) {
    return (el: Element) => ({ overflowX: map.get(el) ?? "visible" }) as CSSStyleDeclaration;
  }

  function setWidths(el: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  }

  it.each(["input", "textarea", "select"])("refuses a start in a %s", (tag) => {
    const root = document.createElement("div");
    const field = document.createElement(tag);
    root.append(field);
    expect(startsInside(field, root, styles(new Map()))).toBe(true);
  });

  it("refuses a start inside contenteditable text", () => {
    const root = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.append(inner);
    root.append(editable);
    expect(startsInside(inner, root, styles(new Map()))).toBe(true);
  });

  it("refuses a start inside a box that scrolls sideways", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 800, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "auto"]])))).toBe(true);
  });

  it("refuses a start inside an overflow-x: scroll box with more to show", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 800, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "scroll"]])))).toBe(true);
  });

  it("allows a start inside a box whose overflow is clipped, not scrolled", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 800, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "hidden"]])))).toBe(false);
  });

  it("allows a start inside an overflow-x box with nothing to scroll", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 300, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "auto"]])))).toBe(false);
  });

  it("does not look past the root", () => {
    const outer = document.createElement("div");
    const root = document.createElement("div");
    const text = document.createElement("p");
    root.append(text);
    outer.append(root);
    setWidths(outer, 800, 300);
    expect(startsInside(text, root, styles(new Map([[outer, "scroll"]])))).toBe(false);
  });
});

/** A `linear()` easing's stops, as `[input, output]` pairs from 0 to 1. */
function stopsOf(easing: string): [number, number][] {
  const inner = /^linear\((.*)\)$/.exec(easing)?.[1];
  if (inner === undefined) throw new Error(`not a linear() easing: ${easing}`);
  const parts = inner.split(",").map((part) => part.trim().split(/\s+/));
  return parts.map(([output, input], i) => [
    input === undefined ? (i === 0 ? 0 : 1) : Number.parseFloat(input) / 100,
    Number(output),
  ]);
}

/** Where a `linear()` easing is at input `x`, between the two stops around it. */
function at(stops: [number, number][], x: number): number {
  const i = stops.findIndex(([input]) => input >= x);
  if (i <= 0) return stops[0]![1];
  const [x0, y0] = stops[i - 1]!;
  const [x1, y1] = stops[i]!;
  return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/**
 * The px from rest, `t` seconds after release, of a critically damped spring
 * with a 0.3s response: written out here, apart from the module, so the curve
 * is checked against the physics rather than against itself.
 */
function spring(from: number, to: number, velocity: number, t: number): number {
  const w = (2 * Math.PI) / 0.3;
  const d0 = from - to;
  return to + (d0 + (velocity * 1000 + w * d0) * t) * Math.exp(-w * t);
}

describe("settleCurve", () => {
  it("leaves at the speed the finger had: the first stretch's slope is the release velocity", () => {
    for (const [from, to, velocity] of [
      [-120, -366, -1.5],
      [-60, 0, 0.4],
      [-200, -366, -0.05],
    ] as const) {
      const curve = settleCurve(from, to, velocity)!;
      const [, [x1, y1]] = stopsOf(curve.easing);
      // Progress per unit of input, turned back into px per ms.
      const speed = ((y1! / x1!) * (to - from)) / curve.duration;
      expect(speed).toBeCloseTo(velocity, 2);
    }
  });

  it("ends at rest: the first millisecond the spring is within a pixel of its target and under 30px/s", () => {
    for (const [from, to, velocity] of [
      [-120, -366, -1.5],
      [-60, 0, 0.4],
      [-20, 0, -1.2],
      [-200, -366, 0.8],
      // Half a pixel from rest but still moving away at 50px/s: inside the
      // pixel from the start, so only its speed says it has not landed.
      [-366.5, -366, -0.05],
    ] as const) {
      const place = (ms: number) => spring(from, to, velocity, ms / 1000);
      // px per second, from the spring's own positions either side.
      const speed = (ms: number) => (place(ms + 0.001) - place(ms - 0.001)) / 0.000002;
      let ms = 1;
      while (Math.abs(place(ms) - to) > 1 || Math.abs(speed(ms)) > 30) ms++;
      expect(settleCurve(from, to, velocity)!.duration).toBeCloseTo(ms, 6);
    }
  });

  it("lands on the rest: its last stop is 1 at the end", () => {
    const stops = stopsOf(settleCurve(-120, -366, -0.5)!.easing);
    expect(stops.at(-1)).toEqual([1, 1]);
    expect(stops[0]).toEqual([0, 0]);
  });

  it("holds a flick faster than ω × the distance left at the rest, ending where it reaches it", () => {
    // 7px/ms with 220px to go: a critically damped spring from here crosses
    // its target and comes back.
    const curve = settleCurve(-146, -366, -7)!;
    const stops = stopsOf(curve.easing);
    for (const [, output] of stops) expect(output).toBeLessThanOrEqual(1);
    const w = (2 * Math.PI) / 0.3;
    const crossing = 220 / (7000 - w * 220);
    expect(curve.duration).toBeCloseTo(crossing * 1000, 0);
  });

  it("settles a full panel from rest in about 0.4s, 95% of the way by about 0.23s", () => {
    const curve = settleCurve(0, -366, 0)!;
    expect(curve.duration).toBeGreaterThan(380);
    expect(curve.duration).toBeLessThan(420);
    const stops = stopsOf(curve.easing);
    expect(at(stops, 230 / curve.duration)).toBeGreaterThan(0.94);
    expect(at(stops, 200 / curve.duration)).toBeLessThan(0.95);
  });

  it("follows the spring to within 0.4px from any release up to 10px/ms, and lands within a pixel on its last stretch", () => {
    // Both sheet widths, from either rest, between them and inside either
    // rubber band, toward either rest, at every speed a finger reaches either
    // way: a stretch whose midpoint happens to sit on its chord can hide a dip
    // or a bend from a check of the midpoint alone.
    const strays: string[] = [];
    for (const width of [366, 480]) {
      for (const share of [-0.1, 0, 0.3, 0.7, 1, 1.1]) {
        for (const to of [0, -width]) {
          for (let velocity = -10; velocity <= 10; velocity++) {
            const from = -width * share;
            if (from === to) continue;
            const curve = settleCurve(from, to, velocity)!;
            const stops = stopsOf(curve.easing);
            const lastStretch = stops.at(-2)![0];
            // The spring ends within a pixel of its target, and the last
            // stretch takes up that pixel, as a spring coming to rest snaps the
            // last of it.
            const worst = { before: 0, last: 0 };
            for (let i = 0; i <= 200; i++) {
              const x = i / 200;
              const drawn = from + (to - from) * at(stops, x);
              const physics = spring(from, to, velocity, (x * curve.duration) / 1000);
              const stretch = x > lastStretch ? "last" : "before";
              worst[stretch] = Math.max(worst[stretch], Math.abs(drawn - physics));
            }
            if (worst.before >= 0.4 || worst.last >= 1) {
              strays.push(`${from} to ${to} at ${velocity}px/ms: ${JSON.stringify(worst)}`);
            }
          }
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it("goes the other way first when released moving away from the rest, and still lands", () => {
    const stops = stopsOf(settleCurve(-20, 0, -1.2)!.easing);
    expect(Math.min(...stops.map(([, output]) => output))).toBeLessThan(0);
    expect(stops.at(-1)).toEqual([1, 1]);
  });

  it("has nothing to move when the panels are already at rest", () => {
    expect(settleCurve(-366, -366, 0)).toBeNull();
    expect(settleCurve(0, 0, 2)).toBeNull();
  });

  it("writes its stops in increasing order, none on another's place", () => {
    for (const [from, velocity] of [
      [-100, -9],
      [-100, -1],
      [-100, 0],
      [-100, 0.3],
      [-100, 4],
      // Already within a pixel of the rest: a settle a millisecond long.
      [-366.5, 0],
    ] as const) {
      const inputs = stopsOf(settleCurve(from, -366, velocity)!.easing).map(([input]) => input);
      for (let i = 1; i < inputs.length; i++) expect(inputs[i]).toBeGreaterThan(inputs[i - 1]!);
    }
  });

  it("offers a cubic-bezier for an engine without linear(): the same first slope, never past the rest", () => {
    for (const [from, to, velocity] of [
      [-120, -366, -1.5],
      [0, -366, 0],
      // From rest toward the start: a slope of +0, where the one above is −0.
      [-366, 0, 0],
      [-146, -366, -7],
      [-20, 0, -1.2],
      // Just under ω × the distance left, on a wide sheet: a start steep
      // enough that the fitted handle would carry the curve past the rest.
      [0, -400, -8],
    ] as const) {
      const curve = settleCurve(from, to, velocity)!;
      const handles = /^cubic-bezier\((.*)\)$/.exec(curve.fallback)![1]!.split(",").map(Number);
      const [x1, y1, x2, y2] = handles as [number, number, number, number];
      for (const x of [x1, x2]) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThanOrEqual(1);
      }
      expect(y1).toBeLessThanOrEqual(1);
      expect(y2).toBe(1);
      const speed = ((y1 / x1) * (to - from)) / curve.duration;
      expect(speed).toBeCloseTo(velocity, 1);
      // Toward the rest, the handle fitted to the spring from rest, wherever
      // the slope leaves room for it under 1; past that, the handle shortens
      // to keep y1 at 1. Released moving away from the rest, the handle
      // shortens, never lengthens, to hold the dip (the next test).
      const away = velocity * (to - from) < 0;
      const fits = (y1 / x1) * 0.17 <= 1;
      const handle = away ? x1 <= 0.17 : (fits ? x1 : y1) === (fits ? 0.17 : 1);
      expect({ from, to, velocity, x1, y1, handle }).toMatchObject({ handle: true });
    }
  });

  it("runs a fallback released moving away from the rest no further the wrong way than the spring", () => {
    for (const [from, to, velocity] of [
      // Out of a rubber band, still moving outward.
      [-20, 0, -1.2],
      [-40, 0, -2],
      // Mid-travel, the finger last moving away from where it lands.
      [-120, -366, 0.3],
      [-200, -366, 0.8],
    ] as const) {
      const curve = settleCurve(from, to, velocity)!;
      const handles = /^cubic-bezier\((.*)\)$/.exec(curve.fallback)![1]!.split(",").map(Number);
      const y1 = handles[1]!;
      const distance = Math.abs(to - from);
      // With y2 at 1, a cubic-bezier's progress at its parameter s depends on
      // y1 alone: 3·y1·s(1 − s)² + 3s²(1 − s) + s³.
      let curveLowest = 0;
      for (let i = 0; i <= 1000; i++) {
        const s = i / 1000;
        const progress = 3 * y1 * s * (1 - s) ** 2 + 3 * s ** 2 * (1 - s) + s ** 3;
        curveLowest = Math.min(curveLowest, progress * distance);
      }
      let springLowest = 0;
      for (let t = 0; t <= curve.duration; t += 0.5) {
        const progress = (spring(from, to, velocity, t / 1000) - from) / (to - from);
        springLowest = Math.min(springLowest, progress * distance);
      }
      expect(springLowest).toBeLessThan(-0.3);
      // As far as the spring goes the wrong way, to half a pixel, and no further.
      expect(Math.abs(curveLowest - springLowest)).toBeLessThan(0.5);
    }
  });

  it("keeps the curve short, however far or fast the release", () => {
    for (const [distance, velocity] of [
      [390, -20],
      [390, 0],
      [390, 20],
      [390, 40],
      [3000, 0],
      [3000, 30],
      // Far faster than a finger, as two samples a glitch puts close together
      // can report: the tangent stop alone strays past the tolerance here.
      [366, 60],
      [366, -60],
      [366, 500],
      [366, -500],
    ] as const) {
      const curve = settleCurve(0, -distance, velocity)!;
      const stops = stopsOf(curve.easing);
      expect(stops.length).toBeLessThanOrEqual(64);
      expect(stops.at(-1)).toEqual([1, 1]);
    }
  });

  it("keeps every stop a curve needs up to the cap of 64, and samples one that needs more again", () => {
    // Releases chosen for their first sampling: exactly 64 stops, then 68.
    expect(stopsOf(settleCurve(0, -300, 21.5)!.easing)).toHaveLength(64);
    expect(stopsOf(settleCurve(0, -300, 23.2)!.easing).length).toBeLessThanOrEqual(64);
  });
});
