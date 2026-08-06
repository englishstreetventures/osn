import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_END_MS,
  INK_FLIP_DELAY_MS,
  SAVED_DWELL_MS,
  SWEEP_DURATION_MS,
  TICK_DELAY_MS,
  TICK_DURATION_MS,
} from "./rsvp-saved";

/**
 * The RSVP confirmation is choreographed across three places that cannot see
 * each other: Tailwind utilities on the button (the sweep), a keyframe in
 * `global.css` (the tick), and a `setTimeout` in `RsvpModal` (the dwell before
 * the sheet closes). Nothing in the toolchain relates them — happy-dom computes
 * no CSS, so no component test can observe the real timing, and every
 * combination type-checks and builds.
 *
 * These are the guards that relate them. The class-level half (the button
 * really does carry `duration-500`, `origin-left`, `scale-x-0`) lives in
 * `RsvpModal.test.tsx`, next to the markup it is pinning.
 */

const GLOBAL_CSS = readFileSync(join(import.meta.dirname, "../styles/global.css"), "utf8");

describe("RSVP confirmation timing", () => {
  it("holds the confirmed state until the sweep and the tick have both finished", () => {
    // The failure this exists to catch: a shortened dwell closes the sheet over
    // a half-drawn tick, which reads as a glitch rather than a confirmation.
    expect(SAVED_DWELL_MS).toBeGreaterThanOrEqual(CONFIRMATION_END_MS);
  });

  it("derives the animation's end from whichever of the two finishes last", () => {
    expect(CONFIRMATION_END_MS).toBe(Math.max(SWEEP_DURATION_MS, TICK_DELAY_MS + TICK_DURATION_MS));
  });

  it("leaves a readable beat after the animation, not just a frame", () => {
    // Without a floor here the guard above is satisfiable by a dwell that ends
    // on the animation's last frame — technically "finished", but the guest
    // would never register what they saw.
    expect(SAVED_DWELL_MS - CONFIRMATION_END_MS).toBeGreaterThanOrEqual(250);
  });

  it("starts the tick before the sweep has finished, so the two read as one gesture", () => {
    expect(TICK_DELAY_MS).toBeLessThan(SWEEP_DURATION_MS);
  });

  it("keeps the dwell short enough that the sheet never feels stuck", () => {
    expect(SAVED_DWELL_MS).toBeLessThanOrEqual(1500);
  });

  it("flips the label's ink while the fill is still travelling, never after it lands", () => {
    // Past the sweep, the flip would read as a second, late change rather than
    // as the fill arriving under the text.
    expect(INK_FLIP_DELAY_MS).toBeLessThan(SWEEP_DURATION_MS);
  });
});

describe("tick keyframe (global.css)", () => {
  /** The `--animate-tick-draw` shorthand, as authored in the theme block. */
  const shorthand = GLOBAL_CSS.match(/--animate-tick-draw:\s*([^;]+);/);

  it("defines the animation the button's `animate-tick-draw` class resolves to", () => {
    expect(shorthand).not.toBeNull();
    expect(shorthand![1]).toContain("tick-draw");
  });

  it("states the duration this module claims it does", () => {
    // Order matters in the CSS shorthand: the FIRST time is the duration and
    // the second is the delay, so the two are matched positionally here rather
    // than by a loose "does 340ms appear anywhere" search that would pass with
    // the pair swapped.
    const times = shorthand![1].match(/(\d+)ms/g);
    expect(times).not.toBeNull();
    expect(times![0]).toBe(`${TICK_DURATION_MS}ms`);
  });

  it("states the delay this module claims it does", () => {
    const times = shorthand![1].match(/(\d+)ms/g);
    expect(times![1]).toBe(`${TICK_DELAY_MS}ms`);
  });

  it("holds the undrawn state through the delay and the drawn state after", () => {
    // Without `both`, the path paints whole during the delay and then draws
    // itself — the confirmation backwards.
    expect(shorthand![1]).toContain("both");
  });

  it("draws the stroke by walking the dash offset to zero", () => {
    const keyframes = GLOBAL_CSS.match(/@keyframes\s+tick-draw\s*\{[\s\S]*?\n\}/);
    expect(keyframes).not.toBeNull();
    expect(keyframes![0]).toMatch(/from\s*\{[^}]*stroke-dashoffset:\s*20/);
    expect(keyframes![0]).toMatch(/to\s*\{[^}]*stroke-dashoffset:\s*0/);
  });

  it("actually clamps BOTH transitions and animations under reduced motion", () => {
    // The negative assertion below (tick-draw is not exempted) proves nothing
    // on its own — it passes just as happily if the block stopped clamping.
    // This branch's whole reduced-motion story is that the sweep (a transition)
    // and the tick (an animation) both land on their end state instantly, so
    // both properties have to be covered, on the universal selector.
    const reduced = GLOBAL_CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*$/);
    expect(reduced).not.toBeNull();
    expect(reduced![0]).toMatch(/\*,/);
    expect(reduced![0]).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reduced![0]).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("leaves the tick to the global reduced-motion clamp rather than opting out", () => {
    // `.animate-spin` is deliberately exempted from the clamp because a frozen
    // spinner lies about progress. A tick has no such claim — it must be
    // allowed to land instantly — so it must NOT appear in that block.
    const reduced = GLOBAL_CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*$/);
    expect(reduced).not.toBeNull();
    expect(reduced![0]).not.toContain("tick-draw");
  });
});
