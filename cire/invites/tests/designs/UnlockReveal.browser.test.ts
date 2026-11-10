/**
 * Each pack's unlock reveal, sampled on every frame in a real browser and held
 * to one timing model: the durations, delays, curves and keyframes the reveal
 * plays, written out below apart from the stylesheet that plays them. A frame
 * off that model — a step too fast or too slow, a different curve, a missing
 * stagger, the events painted before their step — fails here, and jsdom can
 * see none of it.
 *
 * Every value a frame may take is the model's value at that frame's time, give
 * or take one frame (`FRAME_MS`), so the check holds on a slow runner and still
 * fails a curve or a duration that is wrong.
 *
 * Writes every sampled frame, and the largest distance from the model per
 * element, to `e2e-artifacts/cire-invites/unlock-reveal/<pack>.json`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";
import { unlockRevealSequence as classicReveal } from "../../src/designs/classic/UnlockReveal.motion";
import { unlockRevealSequence as galaReveal } from "../../src/designs/gala/UnlockReveal.motion";

/** Typed accessor for the command registered in `vitest.config.ts`. */
const emulate = (options: { reducedMotion?: "reduce" | "no-preference" }) =>
  (commands as unknown as { emulateMedia: (o: typeof options) => Promise<void> }).emulateMedia(
    options,
  );

/** Relative to the package root, where `commands.writeFile` resolves. */
const ARTIFACTS = "../../e2e-artifacts/cire-invites/unlock-reveal";

/** One frame either way: what a sample may lead or trail the model by. */
const FRAME_MS = 17;
const OPACITY_SLACK = 0.02;
const PX_SLACK = 0.5;

type Curve = (x: number) => number;

/** CSS `cubic-bezier()`, solved for x by bisection. */
function bezier(x1: number, y1: number, x2: number, y2: number): Curve {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

const EASE_IN = bezier(0.42, 0, 1, 1);
const EASE_IN_OUT = bezier(0.42, 0, 0.58, 1);
/** The house `--ease-out`. */
const HOUSE_OUT = bezier(0.22, 1, 0.36, 1);
const GALA_OUT = bezier(0.16, 1, 0.3, 1);

/**
 * One element's motion. The curve eases the whole tween, and the opacity
 * values sit evenly along it: the shimmer's four values are one ease-in-out,
 * not four.
 */
interface Tween {
  duration: number;
  delay?: number;
  ease: Curve;
  opacity: readonly number[];
  /** `translateY` from and to, in px. */
  y?: readonly [number, number];
}

interface PackModel {
  leave: Tween;
  welcome: Tween;
  shimmer: Tween;
  section: Tween;
  card: (index: number) => Tween;
  /** Between the welcome's start and the events' step. */
  beatMs: number;
}

const MODELS: Record<"classic" | "gala", PackModel> = {
  classic: {
    leave: { duration: 350, ease: EASE_IN, opacity: [1, 0], y: [0, -12] },
    welcome: { duration: 500, ease: HOUSE_OUT, opacity: [0, 1], y: [16, 0] },
    shimmer: { duration: 1200, ease: EASE_IN_OUT, opacity: [0.4, 1, 0.85, 1] },
    section: { duration: 500, ease: HOUSE_OUT, opacity: [0, 1], y: [32, 0] },
    card: (i) => ({
      duration: 450,
      delay: 150 + 120 * i,
      ease: HOUSE_OUT,
      opacity: [0, 1],
      y: [24, 0],
    }),
    beatMs: 200,
  },
  gala: {
    leave: { duration: 300, ease: EASE_IN, opacity: [1, 0], y: [0, -8] },
    welcome: { duration: 400, ease: GALA_OUT, opacity: [0, 1], y: [10, 0] },
    shimmer: { duration: 1000, ease: EASE_IN_OUT, opacity: [0.5, 1, 0.9, 1] },
    section: { duration: 400, ease: GALA_OUT, opacity: [0, 1], y: [20, 0] },
    card: (i) => ({
      duration: 350,
      delay: 100 + 80 * i,
      ease: GALA_OUT,
      opacity: [0, 1],
      y: [16, 0],
    }),
    beatMs: 150,
  },
};

function progress(tween: Tween, elapsed: number): number {
  const active = (elapsed - (tween.delay ?? 0)) / tween.duration;
  return tween.ease(Math.min(1, Math.max(0, active)));
}

function opacityAt(tween: Tween, elapsed: number): number {
  const values = tween.opacity;
  const p = progress(tween, elapsed) * (values.length - 1);
  const i = Math.min(values.length - 2, Math.floor(p));
  return values[i]! + (values[i + 1]! - values[i]!) * (p - i);
}

function yAt(tween: Tween, elapsed: number): number {
  const [from, to] = tween.y ?? [0, 0];
  return from + (to - from) * progress(tween, elapsed);
}

/** The model's range over one frame either side of `elapsed`. */
function rangeOf(value: (elapsed: number) => number, elapsed: number): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let k = -4; k <= 4; k++) {
    const v = value(elapsed + (k * FRAME_MS) / 4);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return [min, max];
}

/** `translateY` read back from a computed `transform`. */
function translateY(transform: string): number {
  if (transform === "none") return 0;
  const values = transform
    .slice(transform.indexOf("(") + 1, -1)
    .split(",")
    .map(Number);
  return transform.startsWith("matrix3d") ? values[13]! : values[5]!;
}

interface Sample {
  opacity: number;
  y: number;
  display: string;
  /** The earliest start time among the element's animations, once one has started. */
  start: number | null;
}

interface Frame {
  t: number;
  els: Record<string, Sample>;
}

function sample(el: HTMLElement): Sample {
  const cs = getComputedStyle(el);
  const starts = el
    .getAnimations()
    .map((a) => a.startTime)
    .filter((s): s is number => typeof s === "number");
  return {
    opacity: Number.parseFloat(cs.opacity),
    y: translateY(cs.transform),
    display: cs.display,
    start: starts.length > 0 ? Math.min(...starts) : null,
  };
}

const CARD_COUNT = 3;

/** The four parts the reveal moves, laid out as the island renders them. */
function mount() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-part="form"><input aria-label="Invitation code" /></div>
    <div data-part="welcome" style="display: none"><h2>Welcome, Sharma family</h2></div>
    <section data-part="section" class="opacity-0">
      ${Array.from({ length: CARD_COUNT }, () => `<div data-event-card><p>An event</p></div>`).join("")}
    </section>`;
  document.body.append(root);
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const form = part("form");
  const welcome = part("welcome");
  const heading = welcome.querySelector("h2")!;
  const section = part("section");
  const cards = [...section.querySelectorAll<HTMLElement>("[data-event-card]")];
  // What the island does on `onFormHidden`: `revealed` swaps the two displays.
  const onFormHidden = () => {
    form.style.display = "none";
    welcome.style.display = "";
  };
  const els: Record<string, HTMLElement> = { form, welcome, heading, section };
  cards.forEach((card, i) => (els[`card${i}`] = card));
  return { root, form, welcome, heading, section, cards, els, onFormHidden };
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

const PACKS = [
  ["classic", classicReveal],
  ["gala", galaReveal],
] as const;

afterEach(async () => {
  document.body.replaceChildren();
  await emulate({ reducedMotion: "no-preference" });
});

describe.each(PACKS)("the %s unlock reveal", (pack, reveal) => {
  const model = MODELS[pack];

  it("plays the same frames as the reveal it replaced", async () => {
    const m = mount();
    const frames: Frame[] = [];
    const record = (t: number) => {
      const els: Record<string, Sample> = {};
      for (const [name, el] of Object.entries(m.els)) els[name] = sample(el);
      frames.push({ t, els });
    };

    record(await nextFrame());
    let settled = false;
    const run = reveal(m.form, m.welcome, m.section, { onFormHidden: m.onFormHidden }).finally(
      () => {
        settled = true;
      },
    );
    // Until the sequence is done and nothing it started is still running.
    const deadline = performance.now() + 6000;
    while (performance.now() < deadline) {
      const t = await nextFrame();
      record(t);
      const running = Object.values(m.els).some((el) => el.getAnimations().length > 0);
      if (settled && !running) break;
    }
    await run;
    for (let i = 0; i < 3; i++) record(await nextFrame());

    // When each element's step began, on the document timeline.
    const starts: Record<string, number | null> = {};
    for (const name of Object.keys(m.els)) {
      starts[name] = frames.find((f) => f.els[name]!.start !== null)?.els[name]!.start ?? null;
    }

    const tweens: Record<string, Tween> = {
      form: model.leave,
      welcome: model.welcome,
      heading: model.shimmer,
      section: model.section,
    };
    for (let i = 0; i < CARD_COUNT; i++) tweens[`card${i}`] = model.card(i);

    // Every frame off the model, collected rather than thrown at the first, so
    // the artifact and the failure both show the whole run.
    const misses: string[] = [];
    const worst: Record<string, { opacity: number; y: number }> = {};
    for (const [name, tween] of Object.entries(tweens)) {
      const start = starts[name];
      if (start === null || start === undefined) {
        misses.push(`${name} never animated`);
        continue;
      }
      const end = start + (tween.delay ?? 0) + tween.duration;
      worst[name] = { opacity: 0, y: 0 };
      for (const frame of frames) {
        const s = frame.els[name]!;
        // The frames its step has started in, through its end. A frame whose
        // animation is still pending is the browser's to place, so it is left
        // to the checks below; the form leaves the layout at its end.
        if (s.start === null || frame.t > end || s.display === "none") continue;
        const elapsed = frame.t - start;
        const [oMin, oMax] = rangeOf((e) => opacityAt(tween, e), elapsed);
        const [yMin, yMax] = rangeOf((e) => yAt(tween, e), elapsed);
        const oOff = Math.max(0, oMin - s.opacity, s.opacity - oMax);
        const yOff = Math.max(0, yMin - s.y, s.y - yMax);
        worst[name] = {
          opacity: Math.max(worst[name]!.opacity, oOff),
          y: Math.max(worst[name]!.y, yOff),
        };
        if (oOff > OPACITY_SLACK) {
          misses.push(`${name} opacity ${s.opacity} at ${elapsed.toFixed(1)}ms`);
        }
        if (yOff > PX_SLACK) misses.push(`${name} translateY ${s.y} at ${elapsed.toFixed(1)}ms`);
      }
    }

    await commands.writeFile(
      `${ARTIFACTS}/${pack}.json`,
      JSON.stringify({ pack, starts, worst, misses, frames }, null, 2),
    );
    expect(misses).toEqual([]);

    // Each step follows the last: the welcome as the leave ends, the events
    // the beat after it, every card with the section.
    const at = (name: string) => starts[name]!;
    const leaveEnd = at("form") + model.leave.duration;
    expect(at("welcome") - leaveEnd).toBeGreaterThan(-FRAME_MS);
    expect(at("welcome") - leaveEnd).toBeLessThan(4 * FRAME_MS);
    expect(Math.abs(at("heading") - at("welcome"))).toBeLessThanOrEqual(FRAME_MS);
    expect(at("section") - at("welcome")).toBeGreaterThan(model.beatMs - FRAME_MS);
    expect(at("section") - at("welcome")).toBeLessThan(model.beatMs + 5 * FRAME_MS);
    for (let i = 0; i < CARD_COUNT; i++) {
      expect(Math.abs(at(`card${i}`) - at("section"))).toBeLessThanOrEqual(FRAME_MS);
    }

    // Nothing in the events paints before their step: the section holds at 0,
    // so no card shows either, until the section's first frame.
    for (const frame of frames) {
      if (frame.els.section!.start !== null) break;
      expect(frame.els.section!.opacity, `the events showed at ${frame.t}`).toBe(0);
    }
    // The form is whole until its own step.
    for (const frame of frames) {
      if (frame.els.form!.start !== null) break;
      expect(frame.els.form!.opacity).toBe(1);
    }

    // The end state, with nothing left running.
    const last = frames.at(-1)!.els;
    expect(last.form!.display).toBe("none");
    expect(last.welcome!).toMatchObject({ opacity: 1, y: 0 });
    expect(last.heading!.opacity).toBe(1);
    expect(last.section!).toMatchObject({ opacity: 1, y: 0 });
    for (let i = 0; i < CARD_COUNT; i++)
      expect(last[`card${i}`]!).toMatchObject({ opacity: 1, y: 0 });
    for (const el of Object.values(m.els)) expect(el.getAnimations()).toHaveLength(0);
  });

  it("lands on the end state at once under reduced motion", async () => {
    await emulate({ reducedMotion: "reduce" });
    const m = mount();
    await reveal(m.form, m.welcome, m.section, { onFormHidden: m.onFormHidden });

    for (let i = 0; i < 5; i++) {
      await nextFrame();
      expect(getComputedStyle(m.form).display).toBe("none");
      expect(sample(m.welcome)).toMatchObject({ opacity: 1, y: 0, start: null });
      expect(sample(m.heading)).toMatchObject({ opacity: 1, start: null });
      expect(sample(m.section)).toMatchObject({ opacity: 1, y: 0, start: null });
      for (const card of m.cards)
        expect(sample(card)).toMatchObject({ opacity: 1, y: 0, start: null });
    }
    for (const el of Object.values(m.els)) expect(el.getAnimations()).toHaveLength(0);
  });
});
