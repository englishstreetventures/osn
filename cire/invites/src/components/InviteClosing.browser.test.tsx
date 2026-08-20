import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { InviteClosing } from "./InviteClosing";

import "../styles/global.css";

/**
 * The closing band's crop layer, MEASURED by a real CSS parser.
 *
 * The narrow layer carries `background-image` TWICE — a plain `url()` first for
 * Safari < 17, then `image-set()` — because a style object cannot repeat a
 * property and `image-set()` is how the 1x/2x pick is expressed. Whether that
 * pair survives parsing is exactly the thing the jsdom tier cannot see: its CSS
 * parser does not know `image-set()` and drops BOTH declarations, so
 * `background-image` reads empty there no matter what the component set. A
 * regression that broke the declaration string would look identical.
 *
 * Chromium parses it the way the specification says: the second declaration
 * wins where it is understood, and the first survives where it is not. So this
 * file asserts the guest-visible fact — at the default device-pixel-ratio of 1,
 * the narrow layer resolves to the 800w `card` variant, not the 1600w `hero`.
 */

const API = "https://api.test";
const IMG = "/api/invite/anita-ben/image/footer?v=7";
const CROP = { x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1000, natH: 500 };

describe("InviteClosing crop layers (real CSS engine)", () => {
  it("keeps both background-image declarations, with image-set() naming card at 1x", () => {
    const { container } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={CROP} />
    ));
    const narrow = container.querySelector("[aria-hidden='true'].md\\:hidden") as HTMLElement;
    expect(narrow).toBeTruthy();

    // Computed, not inline: this is what the engine kept after parsing both.
    const bg = getComputedStyle(narrow).backgroundImage;
    expect(bg).toContain(`${API}${IMG}&variant=card`);
    expect(bg).toContain("image-set(");
    // The 1600w hero is only ever the 2x candidate down here. A DPR-1 phone
    // resolving it would be the whole regression this split exists to stop.
    // Chromium serialises the `1x` resolution as `1dppx`; accept either.
    expect(bg).toMatch(/variant=card[^)]*\)\s*(1x|1dppx)/);

    // Crop framing is untouched by the split.
    expect(getComputedStyle(narrow).backgroundSize).toBe("200%");
  });

  it("leaves the wide layer on a single plain hero url", () => {
    const { container } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={CROP} />
    ));
    const wide = container.querySelector("[aria-hidden='true'].md\\:block") as HTMLElement;
    const bg = getComputedStyle(wide).backgroundImage;
    expect(bg).toContain(`${API}${IMG}&variant=hero`);
    expect(bg).not.toContain("image-set(");
  });
});
