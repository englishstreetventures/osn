import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

import type { GuestDataBound } from "../../src/components/CreateWeddingForm";
import GuestDataBoundNotice, {
  GuestDataBoundBanner,
} from "../../src/components/GuestDataBoundNotice";

/**
 * The guest-data warning names events as a host typed them, and an event's name
 * can be one word as long as the editor allows. At a phone's width and a
 * desk's, the banner's words break inside it: nothing runs past the banner and
 * the page never scrolls sideways.
 */

const LONG_NAME = "A".repeat(200);

const BOUND: GuestDataBound = {
  state: "near",
  reason: "unreadable-date",
  from: "2026-11-30T12:00:00.000Z",
  events: [LONG_NAME, "Reception"],
  eventCount: 2,
};

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

describe("GuestDataBoundNotice, laid out", () => {
  for (const width of [390, 1280]) {
    it(`keeps a 200-letter event name inside the banner at ${width}px`, async () => {
      await page.viewport(width, 844);
      render(() => (
        <div class="page-frame">
          <GuestDataBoundNotice bound={BOUND} callerRole="owner" onFix={() => {}} />
        </div>
      ));
      const banner = screen.getByTestId("guest-data-bound");
      const right = banner.getBoundingClientRect().right;

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(right).toBeLessThanOrEqual(width);
      for (const el of banner.querySelectorAll<HTMLElement>("p, button")) {
        expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
        // Its words stay inside its own box, which a box's edge alone
        // cannot show: text that does not break spills past it.
        expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
      }
    });
  }
});

/**
 * The owner's choice for this banner: cleared by a save, it shrinks and fades
 * on `--dur-base` before it goes, and the space under it closes with it, so the
 * page below moves up with no jump at the end; under reduced motion it goes at
 * once.
 */
describe("GuestDataBoundBanner, leaving", () => {
  const showInPage = () => {
    const [bound, setBound] = createSignal<GuestDataBound | undefined>(BOUND);
    render(() => (
      <div class="page-frame flex flex-col gap-8" data-testid="page">
        <GuestDataBoundBanner bound={bound()} callerRole="owner" onFix={() => {}} />
        <p>Below the banner</p>
      </div>
    ));
    const wrapper = screen.getByTestId("guest-data-bound").closest<HTMLElement>(".bound-leave")!;
    return { setBound, wrapper, below: screen.getByText("Below the banner") };
  };

  it("shrinks and fades before it goes, and closes the space under it", async () => {
    await commands.emulateMedia({ reducedMotion: "no-preference" });
    const { setBound, wrapper, below } = showInPage();
    const pageTop = screen.getByTestId("page").getBoundingClientRect().top;
    expect(below.getBoundingClientRect().top).toBeGreaterThan(pageTop);

    setBound(undefined);
    await nextFrame();

    // Held drawn while it runs, on a duration of its own.
    expect(getComputedStyle(wrapper).display).not.toBe("none");
    expect(Number.parseFloat(getComputedStyle(wrapper).transitionDuration)).toBeGreaterThan(0);
    await expect.poll(() => getComputedStyle(wrapper).display, { timeout: 2000 }).toBe("none");
    // No gap left behind to close in a jump.
    expect(below.getBoundingClientRect().top).toBeCloseTo(pageTop, 0);
  });

  it("goes at once under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    const { setBound, wrapper } = showInPage();

    setBound(undefined);
    await nextFrame();

    // Gone on the next frame: no shrink is declared under reduced motion.
    expect(getComputedStyle(wrapper).display).toBe("none");
  });
});
