import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { LoginSection, type LoginSectionLayout } from "../../src/components/LoginSection";
import type { ClaimResult } from "../../src/components/types";

/**
 * The account-link panel inside the claim and welcome panel, measured in a
 * real browser at phone width.
 *
 * The panel layout is a 400px card inside the page gutter, so on a 375px phone
 * the account link's member rows get about 200px — less than a long name plus
 * the linked state and its Unlink button need on one line. jsdom lays nothing
 * out, so only this tier can see a row push past the card.
 *
 * The real `PulseAccountLink` renders here. It draws its member rows only when
 * the claim payload offers linking and says the browser is signed in, so the
 * household below carries both; otherwise it would draw nothing, and every box
 * below would pass by being empty.
 */

const household: ClaimResult = {
  publicId: "FEATHERSTONEHAUGH-JOY-RK97",
  familyName: "Featherstonehaugh",
  members: [
    {
      guestId: "g-max",
      firstName: "Maximiliana",
      lastName: "Featherstonehaugh",
      nickname: null,
      eventIds: [],
    },
    {
      guestId: "g-bo",
      firstName: "Bo",
      lastName: "Featherstonehaugh",
      nickname: null,
      eventIds: [],
    },
  ],
  events: [],
  rsvps: [],
  accountLink: { enabled: true, signedIn: true, linkedGuestIds: ["g-max"] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each<LoginSectionLayout>(["band", "panel"])(
  "LoginSection (%s) — the account link at phone width",
  (layout) => {
    it("keeps every member row inside the panel", async () => {
      await page.viewport(375, 900);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
      );

      const view = render(() => (
        <LoginSection
          apiUrl="https://api.test"
          result={household}
          onClaimed={() => {}}
          onSignOut={() => {}}
          layout={layout}
        />
      ));

      // Vacuity guard: the rows and the linked state are actually drawn.
      const heading = await view.findByText("Link your Pulse account", {}, { timeout: 3000 });
      await view.findByText("Which guest are you?");
      const link = heading.closest("section") as HTMLElement;
      const rows = [...link.querySelectorAll("li")];
      expect(rows).toHaveLength(2);
      expect(link.textContent).toContain("Linked");
      expect(link.textContent).toContain("Unlink");

      // The frame the link must stay inside: the card in the panel layout, the
      // page-wide band otherwise.
      const frame = [...document.querySelectorAll<HTMLElement>("[style]")].find(
        (el) => el.style.getPropertyValue("background-color") === "var(--invite-section-bg)",
      )!;
      const frameBox = frame.getBoundingClientRect();
      const linkBox = link.getBoundingClientRect();
      expect(linkBox.width, "the account link has no box").toBeGreaterThan(0);
      expect(linkBox.left).toBeGreaterThanOrEqual(frameBox.left);
      expect(linkBox.right).toBeLessThanOrEqual(frameBox.right);

      for (const row of rows) {
        const box = row.getBoundingClientRect();
        expect(row.scrollWidth, "a member row overflows its own box").toBeLessThanOrEqual(
          row.clientWidth,
        );
        expect(box.right, "a member row runs past the account link").toBeLessThanOrEqual(
          linkBox.right,
        );
        for (const child of row.querySelectorAll<HTMLElement>("button, output, label")) {
          expect(
            child.getBoundingClientRect().right,
            `"${child.textContent}" runs past its row`,
          ).toBeLessThanOrEqual(box.right);
        }
      }

      // And the page itself never scrolls sideways.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    });
  },
);
