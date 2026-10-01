import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { LoginSection, type LoginSectionLayout } from "../../src/components/LoginSection";
import type { ClaimResult } from "../../src/components/types";

/**
 * The account-link box inside the claim and welcome panel, measured in a real
 * browser at phone width.
 *
 * The panel layout is a 400px card inside the page gutter, so on a 375px phone
 * the box gets about 200px — less than a long display name and handle beside
 * the picture, plus the linked state, Unlink and "Not you?", need on one line.
 * jsdom lays nothing out, so only this tier can see a row push past the card.
 *
 * The real `PulseAccountLink` renders here. It draws the account only when the
 * payload has the member step on, a member chosen, and a signed-in account
 * that matches the member's link; otherwise it would draw less, and every box
 * below would pass by being nearly empty.
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
  accountLink: {
    enabled: true,
    signedIn: true,
    linkedGuestIds: ["g-max"],
    account: {
      displayName: "Maximiliana Featherstonehaugh-Worthington",
      handle: "maximiliana_featherstonehaugh",
      avatarUrl: null,
      matchesMember: true,
    },
  },
  member: { guestId: "g-max" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each<LoginSectionLayout>(["band", "panel"])(
  "LoginSection (%s) — the account link at phone width",
  (layout) => {
    it("keeps the account and its controls inside the panel", async () => {
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
          onMemberChange={() => {}}
          layout={layout}
        />
      ));

      // Vacuity guard: the account, the linked state and the controls are drawn.
      const heading = await view.findByText("Link your musubi account", {}, { timeout: 3000 });
      const link = heading.closest("section") as HTMLElement;
      expect(link.textContent).toContain("@maximiliana_featherstonehaugh");
      expect(link.textContent).toContain("Linked");
      expect(link.textContent).toContain("Unlink");
      expect(link.textContent).toContain("Not you?");

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

      for (const child of link.querySelectorAll<HTMLElement>("button, output, span, p")) {
        expect(
          child.getBoundingClientRect().right,
          `"${child.textContent}" runs past the account link`,
        ).toBeLessThanOrEqual(linkBox.right + 0.5);
      }

      // And the page itself never scrolls sideways.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    });
  },
);
