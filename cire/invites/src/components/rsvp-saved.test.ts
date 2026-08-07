import { describe, expect, it } from "vitest";

import { SAVED_DWELL_MS } from "./rsvp-saved";

/**
 * The RSVP sheet's own confirmation is just a held "Saved" label now — the
 * animated half (the sweep, the tick, the tick keyframe in `global.css`) moved
 * to the Respond button and is pinned in `rsvp-responded.test.ts`. What is
 * left to guard here is just the dwell itself.
 */
describe("RSVP sheet dwell", () => {
  it("holds long enough to read, not just a frame", () => {
    expect(SAVED_DWELL_MS).toBeGreaterThanOrEqual(400);
  });

  it("stays short enough that the sheet never feels stuck", () => {
    expect(SAVED_DWELL_MS).toBeLessThanOrEqual(1500);
  });
});
