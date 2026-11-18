/**
 * The Gilded wave, in Chromium: one test per way it can fail (NEW-FEAT.md,
 * isolated tests 6–12 and 14).
 *
 * The wave hands a fixed frame over to or from the page through a View
 * Transition whose new (or old) picture of the frame is cut by a feathered
 * circle that grows from the source; a WebGL 2 canvas draws the gold over it.
 * The View Transition and its mask are the contract, the canvas decoration, so
 * every failure below must still end with the frame where it was asked to be
 * and nothing of the transition left on `<html>`.
 *
 * Most tests hold the wave at one point of its run (`holdGilded`), the hook
 * the E2E flow screenshots with, so nothing here waits on the wave's 2.5 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import { GildedWave, holdGilded, releaseGilded } from "../src/gilded/gilded";
import { maskAt, WAVE, waveAt } from "../src/gilded/wave";

type MediaPreference = { reducedMotion?: "reduce" | "no-preference" };
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

const root = document.documentElement;
const MASK = "--cire-gilded-mask";
const DUR = "--cire-gilded-dur";

let frame: HTMLElement;
let source: HTMLButtonElement;
let wave: GildedWave;
let handovers: boolean[];
let finishes: boolean[];
const extra: Element[] = [];

const mask = () => root.style.getPropertyValue(MASK);
const overlayCanvas = () => document.querySelector("canvas[data-gilded-fx]");

/** Nothing of a transition is left on the page. */
function expectCleared() {
  expect(root.classList.contains("cire-gilded")).toBe(false);
  expect(mask()).toBe("");
  expect(root.style.getPropertyValue(DUR)).toBe("");
  expect(frame.style.viewTransitionName).toBe("");
  const canvas = overlayCanvas() as HTMLCanvasElement | null;
  expect(canvas?.style.viewTransitionName ?? "").toBe("");
}

function flip(revealed: boolean) {
  wave.update({
    revealed,
    source,
    onHandover: (r) => handovers.push(r),
    onFinish: (r) => finishes.push(r),
  });
}

beforeEach(() => {
  document.body.style.margin = "0";
  source = document.createElement("button");
  source.textContent = "Preview";
  source.style.cssText = "position:fixed;top:64px;right:16px;height:28px;width:88px";
  frame = document.createElement("section");
  frame.hidden = true;
  frame.style.cssText =
    "position:fixed;top:120px;left:0;right:0;bottom:0;z-index:30;background:#f3ecdf;overflow:auto";
  frame.textContent = "The invite";
  document.body.append(source, frame);
  handovers = [];
  finishes = [];
  wave = new GildedWave(frame);
  flip(false);
});

afterEach(async () => {
  releaseGilded();
  wave.destroy();
  frame.remove();
  source.remove();
  for (const el of extra.splice(0)) el.remove();
  vi.restoreAllMocks();
  await emulateMedia({ reducedMotion: "no-preference" });
});

describe("GildedWave", () => {
  it("swaps with a fade on the panel-swap step where there is no startViewTransition", async () => {
    Object.defineProperty(document, "startViewTransition", {
      value: undefined,
      configurable: true,
    });
    try {
      flip(true);
      expect(frame.hidden).toBe(false);
      const fades = frame.getAnimations();
      expect(fades).toHaveLength(1);
      // `--dur-slow` is not defined on this page, so the fade takes its
      // fallback: the step's value at a desk.
      expect(fades[0]!.effect?.getComputedTiming().duration).toBe(200);
      await vi.waitFor(() => expect(finishes).toEqual([true]));
      expect(handovers).toEqual([true]);
      expect(wave.debug.mode).toBeNull();

      flip(false);
      await vi.waitFor(() => expect(finishes).toEqual([true, false]));
      expect(frame.hidden).toBe(true);
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
  });

  it("still swaps and clears its names and variables when the transition's ready rejects", async () => {
    // A second element under the frame's name: the new state holds the name
    // twice, so the browser aborts the transition after running its update.
    const decoy = document.createElement("div");
    decoy.style.cssText = "view-transition-name:cire-gilded-frame;width:10px;height:10px";
    document.body.append(decoy);
    extra.push(decoy);

    flip(true);
    await vi.waitFor(() => expect(finishes).toEqual([true]), { timeout: 5000 });
    expect(frame.hidden).toBe(false);
    expect(handovers).toEqual([true]);
    expectCleared();
  });

  it("runs the transition with its mask and no canvas where there is no WebGL 2", async () => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === "webgl2") return null;
      return (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof getContext);

    await holdGilded(0.3);
    flip(true);
    await vi.waitFor(() => expect(mask()).toMatch(/^radial-gradient\(/));
    expect(root.classList.contains("cire-gilded")).toBe(true);
    expect(frame.style.viewTransitionName).toBe("cire-gilded-frame");
    expect(wave.debug.overlay).toBe(false);
    expect(overlayCanvas()).toBeNull();

    releaseGilded();
    await vi.waitFor(() => expect(finishes).toEqual([true]));
    expect(frame.hidden).toBe(false);
    expectCleared();
  });

  it("crossfades and starts no transition under reduced motion", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    const start = vi.spyOn(document, "startViewTransition");

    flip(true);
    expect(start).not.toHaveBeenCalled();
    expect(frame.hidden).toBe(false);
    expect(frame.getAnimations()).toHaveLength(1);
    await vi.waitFor(() => expect(finishes).toEqual([true]));
    expect(handovers).toEqual([true]);
    expect(overlayCanvas()).toBeNull();
  });

  it("runs the transition without its overlay when the shader does not compile", async () => {
    vi.spyOn(WebGL2RenderingContext.prototype, "getShaderParameter").mockReturnValue(false);

    await holdGilded(0.3);
    flip(true);
    await vi.waitFor(() => expect(mask()).toMatch(/^radial-gradient\(/));
    expect(wave.debug.overlay).toBe(false);
    expect(overlayCanvas()).toBeNull();

    releaseGilded();
    await vi.waitFor(() => expect(finishes).toEqual([true]));
    expect(frame.hidden).toBe(false);
    expectCleared();
  });

  it("clears its class, variables and names when another transition skips it", async () => {
    await holdGilded(0.3);
    flip(true);
    await vi.waitFor(() => expect(mask()).toMatch(/^radial-gradient\(/));
    expect(root.classList.contains("cire-gilded")).toBe(true);

    // Any other View Transition on the page skips the one running.
    const other = document.startViewTransition(() => {});
    await other.finished;
    await vi.waitFor(() => expect(handovers).toEqual([true]));
    expect(frame.hidden).toBe(false);
    expectCleared();

    releaseGilded();
    await vi.waitFor(() => expect(finishes).toEqual([true]));
  });

  it("cuts the mask on the front the overlay draws, from the same function", async () => {
    const p = 0.45;
    await holdGilded(p);
    flip(true);
    await vi.waitFor(() => expect(mask()).toMatch(/^radial-gradient\(/));
    expect(wave.debug.overlay).toBe(true);
    await page.screenshot();

    const stage = wave.debug.stage!;
    const front = waveAt(stage, p);
    const cut = maskAt(stage, p);
    // The mask is in the frame's CSS pixels; the stage in the canvas's device pixels.
    const parsed =
      /circle at ([\d.-]+)px ([\d.-]+)px, #000 ([\d.]+)px, transparent ([\d.]+)px/.exec(mask());
    expect(parsed).not.toBeNull();
    const [, x, y, inner, outer] = parsed!.map(Number);
    // Centred on the source: no press, so no lean toward one side of it.
    const from = source.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    expect(x).toBeCloseTo(from.left + from.width / 2 - box.left, 0);
    expect(y).toBeCloseTo(from.top + from.height / 2 - box.top, 0);
    // The circle the page shows through is the overlay's front: its feather
    // straddles the radius `waveAt` draws the crest on.
    expect(inner! * stage.dpr + cut.inner).toBeCloseTo(front.radius, 0);
    expect(outer! * stage.dpr - cut.outer).toBeCloseTo(front.radius, 0);
    // Opaque behind the crest, clear ahead of it, and only just either side: a
    // wider feather leaves the page trailing behind the gold.
    expect(cut.inner).toBeLessThan(0.05 * front.reach);
    expect(cut.outer).toBeLessThan(0.06 * front.reach);
  });

  it("ends a run whose frames stop, by its deadline", async () => {
    // A tab sent to the background, or throttled, stops calling back.
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      flip(true);
      // The transition is up and the run has asked for its first frame.
      await vi.waitFor(() => expect(raf).toHaveBeenCalled(), { timeout: 5000 });
      expect(wave.debug.mode).toBe("wave");

      // Not before the run's own length: a slow frame is not a frozen one.
      vi.advanceTimersByTime(WAVE.duration * 1000);
      expect(finishes).toEqual([]);
      expect(wave.debug.mode).toBe("wave");

      vi.advanceTimersByTime(2500);
      expect(finishes).toEqual([true]);
      expect(wave.debug.mode).toBeNull();
      expect(frame.hidden).toBe(false);
      expectCleared();
    } finally {
      vi.useRealTimers();
    }
  });
});
