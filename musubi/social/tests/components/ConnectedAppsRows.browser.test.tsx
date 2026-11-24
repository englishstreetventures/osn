import type { OidcConnection } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { Card } from "@shared/ui/ui/card";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * Settings → Connected apps draws each app as a bordered row nested inside
 * Settings' card, so it takes the nested-row shape `DESIGN.md` §Radii gives:
 * `Card radius="md" padding="sm"`, an 8px corner and 16px of padding. Measured
 * in a real browser at a phone width and a desktop width, since the row's
 * Revoke button grows to the touch height below `md`, so the row is 74px
 * there and 70px from `md`. A row whose app sent its own screen for removing a
 * person's data draws "Remove my data from <app>" on a line of its own under
 * that, 12px below, at the row's start, at a row action's height, 40px below
 * `md` and 28px from it: 126px and 110px. `AppRowsLoading` holds the same
 * heights, row by row (`LoadingShapes.browser.test.tsx` and
 * `PlaceholderRows.browser.test.tsx` hold the placeholder against the rows
 * that land).
 *
 * The page draws a link only through `followableLink`: `https:`, or `http:` to
 * this machine. Its refusals stay here whatever else covers the list.
 */

const list = vi.hoisted(() => ({ apps: [] as unknown[] }));

vi.mock("../../src/lib/authClients", () => ({
  connectionsClient: {
    list: () => Promise.resolve({ connections: list.apps }),
    revoke: () => Promise.resolve(),
  },
}));

import { ConnectedAppsSection } from "../../src/components/ConnectedAppsSection";

const CIRE_LINK = "https://host.cireweddings.com/#/remove-data";

function app(
  clientId: string,
  clientName: string | null,
  manageDataUrl: string | null,
): OidcConnection {
  return {
    clientId,
    clientName,
    logoUrl: null,
    profileId: "prof_1",
    scope: "openid profile",
    grantedAt: 1_700_000_000,
    manageDataUrl,
  };
}

const cire = app("cid_cire", "Cire", CIRE_LINK);
const pulse = app("cli_pulse", "Pulse", null);

/** A landed session, new per render so each render has a fresh page cache. */
function SignedIn(props: { children: JSX.Element }) {
  const session = { accessToken: "tkn", idToken: null, expiresAt: 0, scopes: [] };
  const value = { session: Object.assign(() => session, { state: "ready", latest: session }) };
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the section reads
    <AuthContext.Provider value={value as any}>{props.children}</AuthContext.Provider>
  );
}

function renderSection() {
  render(() => (
    <SignedIn>
      <Card padding="md">
        <ConnectedAppsSection />
      </Card>
    </SignedIn>
  ));
}

/** The row `el` sits in. */
function rowOf(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>("[data-app]")!;
}

beforeEach(async () => {
  await page.viewport(1440, 900);
});

afterEach(() => {
  cleanup();
  list.apps = [];
});

describe("Settings → Connected apps rows", () => {
  it.each([
    [390, 74, 126, 40],
    [1440, 70, 110, 28],
  ])(
    "at %ipx an app row is %ipx tall, %ipx with its link, the link %ipx tall at the row's start",
    async (width, plain, withLink, linkHeight) => {
      await page.viewport(width, 900);
      list.apps = [cire, pulse];
      renderSection();
      const pulseRow = rowOf(await screen.findByText("Pulse"));
      const cireRow = rowOf(screen.getByText("Cire"));
      for (const row of [pulseRow, cireRow]) {
        const style = getComputedStyle(row);
        expect(style.borderTopWidth).toBe("1px");
        expect(style.borderTopLeftRadius).toBe("8px");
        expect(style.borderBottomRightRadius).toBe("8px");
        expect([
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
        ]).toEqual(["16px", "16px", "16px", "16px"]);
      }
      expect(pulseRow.getBoundingClientRect().height).toBe(plain);
      expect(cireRow.getBoundingClientRect().height).toBe(withLink);

      // The link: 12px under the row's head, its fill on the row's content
      // edge, as wide as its words rather than the row.
      const link = screen.getByRole("link", { name: "Remove my data from Cire" });
      const revoke = cireRow.querySelector("button")!;
      const box = link.getBoundingClientRect();
      const rowBox = cireRow.getBoundingClientRect();
      expect(box.height).toBe(linkHeight);
      expect(box.left).toBe(rowBox.left + 1 + 16);
      expect(box.top).toBe(revoke.parentElement!.getBoundingClientRect().bottom + 12);
      expect(box.width).toBeLessThan(rowBox.width - 2 - 32);
      await page.screenshot({
        path: `../../../../e2e-artifacts/musubi-connected-apps/rows-${width}.png`,
      });
    },
  );

  it("draws Remove my data from Cire to Cire's own screen, in a tab of its own", async () => {
    list.apps = [cire];
    renderSection();
    const link = await screen.findByRole("link", { name: "Remove my data from Cire" });
    expect(link.getAttribute("href")).toBe(CIRE_LINK);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // Its words name the app, so it carries no description to repeat it (`DESIGN.md` §Links).
    expect(link.hasAttribute("aria-describedby")).toBe(false);
  });

  it("draws no link on a row whose app sent none", async () => {
    list.apps = [pulse];
    renderSection();
    await screen.findByText("Pulse");
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it.each([
    ["plain http to a public host", app("cid_cire", "Cire", "http://host.cireweddings.com/#/x")],
    ["a script address", app("cid_cire", "Cire", "javascript:alert(1)")],
    ["an app with no name", app("cid_cire", null, CIRE_LINK)],
  ])("draws no link for %s", async (_what, refused) => {
    list.apps = [refused];
    renderSection();
    await screen.findByRole("button", { name: "Revoke" });
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("keeps a 64-character name's link on one line, inside the row, at 320px", async () => {
    await page.viewport(320, 900);
    const name = `Cire ${"Weddings ".repeat(7)}Planner`.slice(0, 64);
    list.apps = [app("cid_cire", name, CIRE_LINK)];
    renderSection();
    const link = await screen.findByRole("link", { name: `Remove my data from ${name}` });
    const row = rowOf(link);
    expect(link.getBoundingClientRect().height).toBe(40);
    expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right - 1 - 16,
    );
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    expect(row.getBoundingClientRect().height).toBe(126);
    await page.screenshot({
      path: "../../../../e2e-artifacts/musubi-connected-apps/long-name-320.png",
    });
  });
});
