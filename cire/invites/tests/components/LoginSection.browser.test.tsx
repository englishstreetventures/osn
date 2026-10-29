import { cleanup, render, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

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

/** The horizontal middle of a box. */
const middle = (el: Element) => {
  const r = el.getBoundingClientRect();
  return (r.left + r.right) / 2;
};

/**
 * Three error lines a guest can meet in the panel: the claim code's, on the
 * form before a claim; the member choice's, under "Who are you?"; and "Not
 * you?"'s, once a member is chosen. Each answers a request, failed here with
 * `fetch` stubbed to a status that says so.
 */
const ERROR_LINES = [
  {
    name: "the claim code's",
    result: null,
    // A 500, whose message fits on one line of the band's form.
    status: 500,
    message: "Something went wrong. Please try again.",
    async trigger(view: ReturnType<typeof render>) {
      await userEvent.fill(view.getByLabelText("Invitation code"), "WRONG-CODE");
      await userEvent.click(view.getByRole("button", { name: "Open invitation" }));
    },
  },
  {
    name: "the member choice's",
    result: { ...household, member: null },
    status: 500,
    message: "Couldn't save that. Please try again.",
    async trigger(view: ReturnType<typeof render>) {
      await userEvent.click(await view.findByRole("button", { name: "Bo" }));
    },
  },
  {
    name: "“Not you?”'s",
    result: household,
    status: 503,
    message: "Couldn't sign you out. Please try again.",
    async trigger(view: ReturnType<typeof render>) {
      // The one beside "Answering as": once its chunk has loaded, the account
      // link draws a second "Not you?", and the two would both match.
      const answering = (await view.findByText(/^Answering as/)).closest("p")!;
      within(answering).getByRole("button", { name: "Not you?" }).click();
    },
  },
] as const;

describe.each(ERROR_LINES)("LoginSection — $name error line keeps the column's alignment", (c) => {
  /** Renders a layout, sets off the error with its request failing, and measures. */
  async function errorLine(layout: LoginSectionLayout) {
    await page.viewport(1024, 900);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: c.status }))),
    );
    const view = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={c.result}
        onClaimed={() => {}}
        onSignOut={() => {}}
        onMemberChange={() => {}}
        layout={layout}
      />
    ));
    await c.trigger(view);
    const alert = await view.findByRole("alert");
    return {
      text: alert.textContent,
      line: alert.getBoundingClientRect(),
      row: alert.parentElement!.getBoundingClientRect(),
      icon: alert.querySelector("svg")!.getBoundingClientRect(),
      middle: middle(alert),
    };
  }

  it("centres the error line's icon and words together on the band", async () => {
    const { text, line, row, middle: mid } = await errorLine("band");
    expect(text).toBe(`Error: ${c.message}`);
    // The line hugs its icon and words, and sits in the middle of the row.
    expect(line.width).toBeGreaterThan(0);
    expect(row.width).toBeGreaterThan(line.width + 40);
    expect(Math.abs(mid - (row.left + row.right) / 2)).toBeLessThan(2);
  });

  it("starts the error line at the column's edge in the panel", async () => {
    const { text, line, row, icon } = await errorLine("panel");
    expect(text).toBe(`Error: ${c.message}`);
    expect(line.width).toBeGreaterThan(0);
    expect(icon.left - row.left).toBeLessThan(2);
  });
});

describe("LoginSection — a claim error too long for one line", () => {
  it("runs from the form's start on the band, its words beside the icon", async () => {
    await page.viewport(1024, 900);
    // A 401: "That code doesn't look right. …" wraps in the band's form.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );
    const view = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={null}
        onClaimed={() => {}}
        onSignOut={() => {}}
        onMemberChange={() => {}}
        layout="band"
      />
    ));
    await userEvent.fill(view.getByLabelText("Invitation code"), "WRONG-CODE");
    await userEvent.click(view.getByRole("button", { name: "Open invitation" }));
    const alert = await view.findByRole("alert");
    const words = alert.lastElementChild!;
    const range = document.createRange();
    range.selectNodeContents(words);
    const lines = [...range.getClientRects()];
    const icon = alert.querySelector("svg")!.getBoundingClientRect();
    const row = alert.parentElement!.getBoundingClientRect();
    expect(new Set(lines.map((r) => Math.round(r.top))).size).toBeGreaterThan(1);
    expect(icon.left - row.left).toBeLessThan(2);
    // The words start beside the icon, and every line starts where the first
    // does, rather than each centred in the row away from the icon.
    expect(lines[0]!.left - icon.right).toBeLessThan(12);
    expect(Math.abs(lines.at(-1)!.left - lines[0]!.left)).toBeLessThan(2);
  });
});
