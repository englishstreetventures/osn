import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { HeroScrollCue } from "../../src/components/HeroScrollCue";

/** jsdom has no scrolling; set the offset and fire the event the browser would. */
function scrollPageTo(y: number) {
  window.scrollY = y;
  window.dispatchEvent(new Event("scroll"));
}

const cueOf = (container: HTMLElement) =>
  container.querySelector("[data-scroll-cue]") as HTMLElement;
const glyphOf = (container: HTMLElement) =>
  container.querySelector("[data-scroll-cue] svg") as SVGSVGElement;

afterEach(() => {
  cleanup();
  window.scrollY = 0;
});

/**
 * The cue's wiring and class contract. Whether it is painted, where it sits,
 * that it fades and that its drift really moves are layout and animation facts
 * jsdom cannot compute; `tests/designs/InviteHeader.browser.test.tsx` measures
 * those in both packs.
 */
describe("HeroScrollCue", () => {
  it("is a hint, hidden from assistive technology and from the pointer", () => {
    const { container } = render(() => <HeroScrollCue />);
    const cue = cueOf(container);

    expect(cue.getAttribute("aria-hidden")).toBe("true");
    expect(cue.getAttribute("role")).toBeNull();
    expect(cue.querySelector("a, button, [tabindex]")).toBeNull();
    // Taps land on the hero beneath it, never on the cue.
    expect(cue.classList.contains("pointer-events-none")).toBe(true);
  });

  it("is shown at the top of the page, with its entry and drift on the glyph", async () => {
    const { container } = render(() => <HeroScrollCue />);
    await Promise.resolve();

    expect(cueOf(container).dataset.scrollCue).toBe("shown");
    expect(cueOf(container).classList.contains("opacity-0")).toBe(false);
    // The animation sits on the glyph and the hide on the wrapper: an entry
    // animation's `both` fill on the wrapper would outrank the hide class.
    expect(glyphOf(container).classList.contains("animate-scroll-cue")).toBe(true);
    expect(glyphOf(container).style.animationPlayState).toBe("");
  });

  it("hides on the first scroll and pauses its drift", async () => {
    const { container } = render(() => <HeroScrollCue />);
    await Promise.resolve();

    scrollPageTo(120);

    expect(cueOf(container).dataset.scrollCue).toBe("hidden");
    expect(cueOf(container).classList.contains("opacity-0")).toBe(true);
    expect(glyphOf(container).style.animationPlayState).toBe("paused");
  });

  it("does not come back when the guest scrolls back to the top", async () => {
    const { container } = render(() => <HeroScrollCue />);
    await Promise.resolve();

    scrollPageTo(120);
    scrollPageTo(0);

    expect(cueOf(container).dataset.scrollCue).toBe("hidden");
  });

  it("centres itself by default", () => {
    const { container } = render(() => <HeroScrollCue />);
    const cue = cueOf(container);
    for (const cls of ["absolute", "bottom-4", "inset-x-0", "justify-center"]) {
      expect(cue.classList.contains(cls)).toBe(true);
    }
  });

  it("sits on the inline end when asked, on the hero's gutter", () => {
    const { container } = render(() => <HeroScrollCue align="end" />);
    const cue = cueOf(container);
    for (const cls of ["absolute", "bottom-4", "right-6"]) {
      expect(cue.classList.contains(cls)).toBe(true);
    }
    expect(cue.classList.contains("inset-x-0")).toBe(false);
  });
});
