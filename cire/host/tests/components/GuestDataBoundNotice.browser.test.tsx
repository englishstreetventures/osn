import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

import type { GuestDataBound } from "../../src/components/CreateWeddingForm";
import GuestDataBoundNotice from "../../src/components/GuestDataBoundNotice";

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

afterEach(() => {
  cleanup();
});

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
