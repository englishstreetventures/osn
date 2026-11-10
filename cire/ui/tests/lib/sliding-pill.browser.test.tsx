/**
 * The glass's move, sampled frame by frame in Chromium on the portals' own
 * curves (read out of `cire/host/src/styles/global.css`, so the test measures
 * what ships): its place on the firmer spring, under 4% past the choice; its
 * size on ease-out, never past the choice's; a second tap mid-move that picks
 * up from where the glass is; and no move at all for a reader who turned
 * motion down. `SegmentedTabs` is the one caller of the spring.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import SegmentedTabs, { type SegmentedItem } from "../../src/segmented-tabs";

import hostCss from "../../../host/src/styles/global.css?raw";
import "../test-support/tailwind.css";

type MediaPreference = { reducedMotion?: "reduce" | "no-preference" };
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

/** A token's value in the host stylesheet, whitespace collapsed; `kind` picks the declaration. */
function token(name: string, kind: "linear" | "cubic-bezier"): string {
  const found = new RegExp(`${name}:\\s*(${kind}\\([^)]*\\))`).exec(hostCss);
  if (!found) throw new Error(`no ${kind} ${name} in cire/host/src/styles/global.css`);
  return found[1]!.replace(/\s+/g, " ");
}

/**
 * The portals' curves, on a clock slowed to 1.6s so each frame moves the
 * glass a fraction of a pixel's worth of the curve. A curve's overshoot is a
 * share of the travel at any speed. `--ease-spring` is set too, so a glass
 * that went back to the house spring would be measured on it.
 */
const CLOCK = "1600ms";
const portal = (glide: "linear" | "cubic-bezier"): JSX.CSSProperties => ({
  "--dur-base": CLOCK,
  "--dur-slow": CLOCK,
  "--ease-out": token("--ease-out", "cubic-bezier"),
  "--ease-spring": token("--ease-spring", "linear"),
  "--ease-glide": token("--ease-glide", glide),
});

const FIVE: SegmentedItem<string>[] = [
  { value: "hero", label: "Hero" },
  { value: "story", label: "Our story" },
  { value: "welcome", label: "Welcome" },
  { value: "events", label: "Events" },
  { value: "closing", label: "Closing" },
];

function Strip(props: { initial: string; style: JSX.CSSProperties }) {
  const [value, setValue] = createSignal(props.initial);
  return (
    <div class="bg-ui-ground p-4" style={props.style}>
      <SegmentedTabs
        items={FIVE}
        value={value()}
        onChange={setValue}
        label="Sections"
        semantics="tabs"
      />
    </div>
  );
}

const glass = () => document.querySelector<HTMLElement>("[data-segmented-glass]")!;
const tab = (name: string) => screen.getByRole("tab", { name });

interface Box {
  x: number;
  width: number;
  height: number;
}

/** A box in the glass's own track's coordinates, so a page that scrolls cannot move it. */
function boxOf(el: HTMLElement): Box {
  const track = glass().parentElement!.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - track.left, width: r.width, height: r.height };
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** The glass's box on every frame for `ms`. */
async function film(ms: number): Promise<Box[]> {
  const frames: Box[] = [];
  const start = await frame();
  for (let now = start; now - start < ms; now = await frame()) frames.push(boxOf(glass()));
  return frames;
}

/** Long enough for any move on the slowed clock to finish. */
const RUN = 1900;

/** Waits out the first placement, which never slides. */
async function placed() {
  await frame();
  await frame();
}

/** How far past the target the glass went, as a share of the travel. */
function overshoot(frames: Box[], from: number, to: number): number {
  const travel = to - from;
  return Math.max(...frames.map((f) => ((f.x - to) * Math.sign(travel)) / Math.abs(travel)));
}

describe("the glass's place", () => {
  for (const glide of ["linear", "cubic-bezier"] as const) {
    it(`springs under 4% past the choice, and settles on it, on the ${glide} curve`, async () => {
      render(() => <Strip initial="hero" style={portal(glide)} />);
      await placed();
      const from = boxOf(glass()).x;
      tab("Closing").click();
      const frames = await film(RUN);
      const to = boxOf(tab("Closing")).x;
      const past = overshoot(frames, from, to);
      expect(past).toBeLessThan(0.04);
      // A spring, still: it goes past and comes back. Ease-out never would.
      expect(past).toBeGreaterThan(0.01);
      expect(Math.abs(frames.at(-1)!.x - to)).toBeLessThan(0.5);
    });
  }
});

describe("the glass's size", () => {
  // From the narrowest choice to the widest and back: growing it must never
  // pass the wider tab, and shrinking it must never pass the narrower.
  for (const [from, to] of [
    ["Hero", "Our story"],
    ["Our story", "Hero"],
  ] as const) {
    it(`never passes the choice's, ${from} to ${to}`, async () => {
      const initial = FIVE.find((item) => item.label === from)!.value;
      render(() => <Strip initial={initial} style={portal("linear")} />);
      await placed();
      const start = boxOf(glass());
      tab(to).click();
      const frames = await film(RUN);
      const end = boxOf(tab(to));
      expect(end.width).not.toBe(start.width);
      const [low, high] = [Math.min(start.width, end.width), Math.max(start.width, end.width)];
      for (const f of frames) {
        expect(f.width).toBeGreaterThanOrEqual(low - 0.5);
        expect(f.width).toBeLessThanOrEqual(high + 0.5);
        expect(Math.abs(f.height - end.height)).toBeLessThan(0.5);
      }
    });
  }
});

describe("a second tap mid-move", () => {
  it("picks up from where the glass is, with no jump", async () => {
    render(() => <Strip initial="hero" style={portal("linear")} />);
    await placed();
    tab("Closing").click();
    const before = await film(500);
    // Read, tap and read again inside one frame: the move's clock has not
    // ticked, so any difference is the glass jumping.
    const last = boxOf(glass());
    tab("Our story").click();
    const first = boxOf(glass());
    expect(last.x).not.toBe(before[0]!.x);
    expect(Math.abs(first.x - last.x)).toBeLessThan(1);
    expect(Math.abs(first.width - last.width)).toBeLessThan(1);
    // And on the next frame it has not leapt either: no step larger than the
    // largest it took on its way out.
    const steps = before.slice(1).map((f, i) => Math.abs(f.x - before[i]!.x));
    const next = boxOf(glass());
    await frame();
    expect(Math.abs(boxOf(glass()).x - next.x)).toBeLessThanOrEqual(Math.max(...steps) + 0.5);
    await film(RUN);
    expect(Math.abs(boxOf(glass()).x - boxOf(tab("Our story")).x)).toBeLessThan(0.5);
  });
});

describe("a reader who turned motion down", () => {
  it("sees the glass on the choice at once", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => <Strip initial="hero" style={portal("linear")} />);
    await placed();
    tab("Closing").click();
    await frame();
    const to = boxOf(tab("Closing"));
    const now = boxOf(glass());
    expect(Math.abs(now.x - to.x)).toBeLessThan(0.5);
    expect(Math.abs(now.width - to.width)).toBeLessThan(0.5);
  });
});
