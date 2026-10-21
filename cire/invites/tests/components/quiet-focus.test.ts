/**
 * Which clicks count as a pointer's. A pointer's press moves focus quietly
 * (no ring), and is ignored on the event sheet's switch while a slide runs; a
 * key's keeps the ring and always goes through. What the mark does to the ring
 * is `EventSheet.browser.test.tsx`'s ("focus after a switch").
 */
import { describe, expect, it } from "vitest";

import { pressedByPointer } from "../../src/components/quiet-focus";

describe("pressedByPointer", () => {
  it.each([
    // Chromium names the pointer, and that settles it, whatever the count says.
    ["a click Chromium names a touch's", new PointerEvent("click", { pointerType: "touch" }), true],
    [
      "a click Chromium names no pointer for",
      new PointerEvent("click", { pointerType: "" }),
      false,
    ],
    // Firefox and Safari send a MouseEvent, which counts a pointer's presses.
    ["a click Firefox or Safari counts", new MouseEvent("click", { detail: 1 }), true],
    ["a click Firefox or Safari does not count", new MouseEvent("click", { detail: 0 }), false],
  ])("reads %s: a pointer's, %s", (_, event, byPointer) => {
    expect(pressedByPointer(event)).toBe(byPointer);
  });
});
