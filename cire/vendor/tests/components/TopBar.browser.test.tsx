/**
 * The vendor top bar at a phone's width, in Chromium with the portal's own
 * stylesheet. The wordmark's box pulls 4px left and none right, so everything
 * after it sits 4px further right than the bars drew it before; the row holds
 * the wordmark, the two view tabs and the account trigger, all of which keep
 * their width. These hold that the row still fits, and that its first frame —
 * the boot bar's still copy of the wordmark — lands where the island's does.
 */

import { WordmarkPlaceholder } from "@cire/ui/wordmark";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

import TopBar from "../../src/components/TopBar";

const SESSION = {
  osnProfileId: "usr_fixture",
  displayName: "Acme Florals",
  handle: "acme",
  email: "hello@acme.test",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
} as const;

afterEach(cleanup);

describe("the vendor top bar", () => {
  for (const width of [320, 390]) {
    it(`keeps its row inside a ${width}px screen`, async () => {
      await page.viewport(width, 700);
      render(() => (
        <div class="@container/frame">
          <TopBar
            session={SESSION}
            view="listings"
            onView={() => {}}
            onHome={() => {}}
            onSignOut={() => {}}
          />
        </div>
      ));
      const row = screen.getByRole("button", { name: "Cire — your listings" }).parentElement!;
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      const trigger = screen.getByRole("button", { name: "Account menu" });
      expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    });
  }

  it("lands the boot bar's wordmark where the island's lands", async () => {
    await page.viewport(390, 700);
    // The two bars as `index.astro` and `TopBar` draw them: the same row.
    render(() => (
      <div class="@container/frame">
        <div class="page-frame flex h-14 items-center gap-2" data-boot>
          <WordmarkPlaceholder />
        </div>
        <TopBar
          session={SESSION}
          view="listings"
          onView={() => {}}
          onHome={() => {}}
          onSignOut={() => {}}
        />
      </div>
    ));
    const boot = document.querySelector("[data-boot] span")!.getBoundingClientRect();
    const island = screen
      .getByRole("button", { name: "Cire — your listings" })
      .getBoundingClientRect();
    expect(boot.left).toBe(island.left);
  });
});
