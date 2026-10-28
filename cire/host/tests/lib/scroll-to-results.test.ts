import { describe, expect, it } from "vitest";

import { scrollDelta } from "../../src/lib/scroll-to-results";

/**
 * The decision behind every "bring the results back into view" move: a
 * search, a reply filter, a sort or an event change that redraws a list the
 * host had scrolled deep into. The page moves only when the results start
 * above the foot of the stuck stack, and then by exactly the distance that
 * puts them at it. The browser half — reading the two edges and scrolling —
 * is proved in `GuestsStack.browser.test.tsx`.
 */
describe("scrollDelta", () => {
  it("leaves the page alone when the results start below the stack", () => {
    expect(scrollDelta(400, 200)).toBe(0);
  });

  it("leaves the page alone when the results start at the stack's foot", () => {
    expect(scrollDelta(200, 200)).toBe(0);
  });

  it("moves the results' top to the stack's foot when they start above it", () => {
    expect(scrollDelta(-3000, 200)).toBe(-3200);
    expect(scrollDelta(150, 200)).toBe(-50);
  });

  it("ignores a sub-pixel gap, and moves from a pixel up", () => {
    // Layout rounds; a results top a fraction above the foot is at the foot.
    expect(scrollDelta(199.5, 200)).toBe(0);
    expect(scrollDelta(199, 200)).toBe(0);
    expect(scrollDelta(198.9, 200)).toBeCloseTo(-1.1, 5);
  });
});
