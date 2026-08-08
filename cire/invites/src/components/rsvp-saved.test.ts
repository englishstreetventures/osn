import { describe, expect, it } from "vitest";

import { SAVED_DWELL_MIN_MS, SAVED_DWELL_MS, savedDwellMs } from "./rsvp-saved";

/**
 * The RSVP sheet's own confirmation is just a held "Saved" label now — the
 * animated half (the sweep, the tick, the tick keyframe in `global.css`) moved
 * to the Respond button and is pinned in `rsvp-responded.test.ts`. What is
 * left to guard here is the dwell itself, and the budget arithmetic that keeps
 * a slow round-trip from stacking on top of it.
 */
describe("RSVP sheet dwell", () => {
  it("holds long enough to read, not just a frame", () => {
    expect(SAVED_DWELL_MIN_MS).toBeGreaterThanOrEqual(250);
  });

  it("stays short enough that the sheet never feels stuck", () => {
    // Budget, not a fixed hold — this is the WHOLE wait after the click on a
    // fast reply, and the ceiling on it for any reply.
    expect(SAVED_DWELL_MS).toBeLessThanOrEqual(700);
  });

  it("holds the spoken confirmation long enough to be announced", () => {
    // The floor is sized by the sheet's `role="status"` region, not by the
    // "Saved" label — the region is destroyed on the same tick the dwell
    // expires, while focus returns to the Respond button (WCAG 2.2 SC 4.1.3;
    // see the module doc and C-L1 in `wiki/todo/security.md`). Pinned
    // separately from the "long enough to read" bound above because the two
    // have different reasons and different magnitudes, and a future reader
    // lowering this for snappiness needs to fail on the right one.
    expect(SAVED_DWELL_MIN_MS).toBeGreaterThanOrEqual(500);
  });

  it("keeps the floor under the budget, so the budget is genuinely the maximum", () => {
    // Every test in this package advances fake timers by `SAVED_DWELL_MS` to
    // land the close. That only works while no input can make `savedDwellMs`
    // return more than it.
    expect(SAVED_DWELL_MIN_MS).toBeLessThanOrEqual(SAVED_DWELL_MS);
  });
});

describe("savedDwellMs", () => {
  it("spends the whole budget when the reply was instant", () => {
    expect(savedDwellMs(0)).toBe(SAVED_DWELL_MS);
  });

  it("deducts the wait already spent rather than adding to it", () => {
    // The bug this exists to fix: a guest used to wait `round-trip + dwell`.
    // Now the round-trip comes OUT of the dwell, so click-to-close stays put —
    // BELOW the knee, which is the only region where that holds. Derived from
    // the constants, not written as a literal: at floor 500 / budget 600 the
    // knee is 100ms, so a hard-coded 200 would sit the wrong side of it.
    const requestMs = Math.floor((SAVED_DWELL_MS - SAVED_DWELL_MIN_MS) / 2);
    expect(savedDwellMs(requestMs)).toBe(SAVED_DWELL_MS - requestMs);
    expect(requestMs + savedDwellMs(requestMs)).toBe(SAVED_DWELL_MS);
  });

  it("never drops below the floor, however slow the reply was", () => {
    // "Saving…" is not a confirmation — only the dwell shows "Saved" — so a
    // request that outran the entire budget must not collapse the one state
    // that tells the guest their reply landed.
    expect(savedDwellMs(SAVED_DWELL_MS)).toBe(SAVED_DWELL_MIN_MS);
    expect(savedDwellMs(10_000)).toBe(SAVED_DWELL_MIN_MS);
  });

  it("never exceeds the budget, so the fake-timer advance in every other test still lands the close", () => {
    // Samples derived from the constants, never written as literals of today's
    // numbers — a retune of either constant must move the samples with it, or
    // they stop bracketing the clamp while still passing (T-M2).
    const knee = SAVED_DWELL_MS - SAVED_DWELL_MIN_MS;
    for (const requestMs of [
      -SAVED_DWELL_MS,
      -1,
      0,
      1,
      knee - 1,
      knee,
      knee + 1,
      SAVED_DWELL_MS,
      SAVED_DWELL_MS * 10,
    ]) {
      expect(savedDwellMs(requestMs)).toBeLessThanOrEqual(SAVED_DWELL_MS);
      expect(savedDwellMs(requestMs)).toBeGreaterThanOrEqual(SAVED_DWELL_MIN_MS);
    }
  });

  it("puts the knee where the two constants say it is", () => {
    // The crossover — the slowest reply that still gets its full share of the
    // budget. Past it the floor takes over and total click-to-close starts
    // GROWING again, which is the one thing the module doc's "closes at roughly
    // SAVED_DWELL_MS however long the server took" glosses over. Pinned as a
    // relationship between the constants rather than as numbers, so it survives
    // an intentional retune of either and fails precisely when a retune changes
    // what a guest waits.
    const knee = SAVED_DWELL_MS - SAVED_DWELL_MIN_MS;
    expect(savedDwellMs(knee)).toBe(SAVED_DWELL_MIN_MS);
    expect(savedDwellMs(knee - 1)).toBe(SAVED_DWELL_MIN_MS + 1);
    // Below the knee the budget is spent exactly, so click-to-close is flat.
    expect(knee - 1 + savedDwellMs(knee - 1)).toBe(SAVED_DWELL_MS);
    // Past it, it is request + floor — strictly worse than the budget, and
    // unbounded in the request. That is the honest shape of the guarantee, and
    // with the floor sized for the announcement the knee is small, so most
    // real saves live on this side of it.
    expect(knee + 1 + savedDwellMs(knee + 1)).toBeGreaterThan(SAVED_DWELL_MS);
  });

  it("falls back to the floor on a non-finite measurement", () => {
    // `Math.max` loses to NaN, which would hand `setTimeout` a NaN delay — and
    // a NaN delay fires immediately, i.e. the sheet vanishes with no
    // confirmation at all. Guarded explicitly rather than left to arithmetic.
    expect(savedDwellMs(Number.NaN)).toBe(SAVED_DWELL_MIN_MS);
  });
});
