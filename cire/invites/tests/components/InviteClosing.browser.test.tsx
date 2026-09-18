import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import { BAND_WIDTH_TRANSITION_CLASS, InviteClosing } from "../../src/components/InviteClosing";

import "../../src/styles/global.css";

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

/** The tester iframe's own default, restored after every test that changes it. */
const DEFAULT: readonly [number, number] = [414, 896];
/** A desktop wider than any invite needs — the width the cap exists for. */
const WIDE: readonly [number, number] = [2560, 900];
/** The first width at which `2xl` matches. */
const AT_CAP: readonly [number, number] = [1536, 900];
/** One pixel below it, where nothing may change. */
const BELOW_CAP: readonly [number, number] = [1535, 900];

/** Typed accessor for the command registered in `vitest.config.ts`. */
const emulate = (options: { reducedMotion?: "reduce" | "no-preference" }) =>
  (commands as unknown as { emulateMedia: (o: typeof options) => Promise<void> }).emulateMedia(
    options,
  );

/** The band's own box — the one thing both image paths hang off. */
const bandBox = (el: HTMLElement) => el.querySelector("[data-invite-closing] > div") as HTMLElement;

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

/*
 * The band's width cap, MEASURED.
 *
 * `InviteClosing.test.tsx` pins the class and the `sizes` string, which is the
 * mechanism. It cannot pin the outcome: a media query is a stylesheet fact, a
 * custom property is substituted at computed-value time, and jsdom resolves
 * neither — `[--invite-band-width:100vw]` and `2xl:[--invite-band-width:640px]`
 * are just characters there, and `getBoundingClientRect` is all zeroes. The
 * outcome is the whole point of the change: the guest on a 2560px screen must
 * get a band on the same measure as the cards above it, and the guest one pixel
 * below the breakpoint must get exactly what shipped before.
 *
 * Nothing here is measured mid-transition — every case resizes first and renders
 * after, so the box mounts at its final width with no transition to race. The
 * transition itself is asserted from the declaration, and under emulated
 * reduced motion from the clamped duration.
 */
describe("the band's width cap (real CSS engine)", () => {
  afterEach(async () => {
    cleanup();
    await emulate({ reducedMotion: "no-preference" });
    await page.viewport(...DEFAULT);
  });

  it.each([
    { pack: "classic", cap: "column-xl" as const, expected: 640 },
    { pack: "gala", cap: "column-2xl" as const, expected: 960 },
  ])("caps $pack's band to $expected px and centres it at 2560px", async ({ cap, expected }) => {
    await page.viewport(...WIDE);
    const { container } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={CROP} bandCap={cap} />
    ));

    const box = bandBox(container).getBoundingClientRect();
    expect(Math.round(box.width)).toBe(expected);
    // Centred, not flush left: the two margins match to within the odd pixel a
    // scrollbar or a half-pixel rounding leaves behind.
    const section = container.querySelector("[data-invite-closing]")!.getBoundingClientRect();
    expect(Math.abs(box.left - section.left - (section.right - box.right))).toBeLessThanOrEqual(1);
  });

  it("caps at 1536px and leaves 1535px exactly as it was", async () => {
    await page.viewport(...AT_CAP);
    const { container: capped } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={CROP} bandCap="column-xl" />
    ));
    expect(Math.round(bandBox(capped).getBoundingClientRect().width)).toBe(640);
    cleanup();

    await page.viewport(...BELOW_CAP);
    // Rendered side by side rather than against a remembered number: the
    // uncapped component is what `main` ships, so the pair answers "is anything
    // different below the breakpoint" directly.
    const { container: below } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={CROP} bandCap="column-xl" />
    ));
    const withCap = bandBox(below).getBoundingClientRect().width;
    cleanup();

    const { container: uncapped } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={CROP} />
    ));
    expect(withCap).toBe(bandBox(uncapped).getBoundingClientRect().width);
    // And it is genuinely the full width, not a coincidence of two caps.
    expect(Math.round(withCap)).toBe(document.documentElement.clientWidth);
  });

  it("caps the uncropped path as well as the cropped one", async () => {
    await page.viewport(...WIDE);
    const { container } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} bandCap="column-xl" />
    ));
    const img = container.querySelector("img") as HTMLImageElement;

    // The plain `<img>` path carries no max-width of its own — the box above it
    // is the only thing standing between it and a 2560px band.
    expect(Math.round(bandBox(container).getBoundingClientRect().width)).toBe(640);
    expect(Math.round(img.getBoundingClientRect().width)).toBe(640);
  });

  it("eases across the breakpoint, and stops when the guest asks for less motion", async () => {
    await page.viewport(...WIDE);
    const { container } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} bandCap="column-xl" />
    ));
    const cs = getComputedStyle(bandBox(container));

    // The property actually written, not the one the class is named after: a
    // transition listing a property the engine never animates is silent.
    expect(cs.transitionProperty).toContain("max-width");
    expect(Number.parseFloat(cs.transitionDuration)).toBeGreaterThan(0);
    expect(BAND_WIDTH_TRANSITION_CLASS).toContain("transition-[max-width]");
    cleanup();

    await emulate({ reducedMotion: "reduce" });
    await page.viewport(...WIDE);
    const { container: quiet } = render(() => (
      <InviteClosing apiUrl={API} imageUrl={IMG} bandCap="column-xl" />
    ));
    const clamped = getComputedStyle(bandBox(quiet));
    expect(Number.parseFloat(clamped.transitionDuration)).toBeLessThan(0.001);
    // The clamp must not cost the cap itself.
    expect(Math.round(bandBox(quiet).getBoundingClientRect().width)).toBe(640);
  });
});
