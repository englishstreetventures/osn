/**
 * Which clicks count as a pointer's. A pointer's press moves focus quietly
 * (no ring), and is ignored on the event sheet's switch while a slide runs; a
 * key's keeps the ring and always goes through. What the mark does to the ring
 * is `EventSheet.browser.test.tsx`'s ("focus after a switch").
 */
import { describe, expect, it } from "vitest";

import { pressedByPointer } from "../../src/components/quiet-focus";

describe("pressedByPointer", () => {
  // Chromium names the pointer, and that settles it, whatever the count says:
  // a tap's click can count no presses. The other readings — a click Chromium
  // names no pointer for, and the counted `MouseEvent` Firefox and Safari send
  // — are pressed for real in `EventSheet.browser.test.tsx` ("keeps the ring
  // for a key press on the switch…") and `AddToCalendar.test.tsx` ("opens on
  // its first item when a key opens it", "opens on the menu itself, quietly,
  // when a pointer opens it").
  it("reads a click Chromium names a touch's as a pointer's, though it counts no presses", () => {
    expect(pressedByPointer(new PointerEvent("click", { pointerType: "touch", detail: 0 }))).toBe(
      true,
    );
  });
});
