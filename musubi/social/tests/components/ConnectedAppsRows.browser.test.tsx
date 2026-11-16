import { AuthContext } from "@osn/client/solid";
import { Card } from "@shared/ui/ui/card";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * Settings → Connected apps draws each app as a bordered row nested inside
 * Settings' card, so it takes the nested-row shape `DESIGN.md` §Radii gives:
 * `Card radius="md" padding="sm"`, an 8px corner and 16px of padding. Measured
 * in a real browser at a phone width and a desktop width, since the row's
 * Revoke button grows to the touch height below `md`, so the row is 74px
 * there and 70px from `md`; `AppRowsLoading` holds the same heights
 * (`LoadingShapes.browser.test.tsx` holds the placeholder against the row that
 * lands).
 */

vi.mock("../../src/lib/authClients", () => ({
  connectionsClient: {
    list: () =>
      Promise.resolve({
        connections: [
          { clientId: "cli_pulse", clientName: "Pulse", logoUrl: null, scope: "openid profile" },
        ],
      }),
    revoke: () => Promise.resolve(),
  },
}));

import { ConnectedAppsSection } from "../../src/components/ConnectedAppsSection";

/** A landed session, new per render so each render has a fresh page cache. */
function SignedIn(props: { children: JSX.Element }) {
  const session = { accessToken: "tkn", idToken: null, expiresAt: 0, scopes: [] };
  const value = { session: Object.assign(() => session, { state: "ready", latest: session }) };
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the section reads
    <AuthContext.Provider value={value as any}>{props.children}</AuthContext.Provider>
  );
}

afterEach(() => {
  cleanup();
});

describe("Settings → Connected apps rows", () => {
  it.each([
    [390, 74],
    [1440, 70],
  ])(
    "at %ipx an app row has an 8px corner, 16px of padding and is %ipx tall",
    async (width, height) => {
      await page.viewport(width, 900);
      render(() => (
        <SignedIn>
          <Card padding="md">
            <ConnectedAppsSection />
          </Card>
        </SignedIn>
      ));
      const name = await screen.findByText("Pulse");
      // The app's name, its text block, the row's left group, then the row.
      const row = name.parentElement!.parentElement!.parentElement!;
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
      expect(row.getBoundingClientRect().height).toBe(height);
      await page.screenshot({
        path: `../../../../e2e-artifacts/musubi-connected-apps/rows-${width}.png`,
      });
    },
  );
});
