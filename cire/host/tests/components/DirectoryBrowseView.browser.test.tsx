import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The vendor directory, painted: its listing dialog stays mounted while
 * closed, and a display class on a `<dialog>` beats the browser's own
 * `dialog:not([open]) { display: none }`, so a closed dialog given `flex`
 * paints as an empty box over the filter bar. Only an engine resolves that.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/vendors-store", () => ({
  invalidateVendors: vi.fn(),
  upsertCachedVendor: vi.fn(),
}));

import DirectoryBrowseView from "../../src/components/DirectoryBrowseView";

const LISTING = {
  id: "LA",
  name: "Acme Venue",
  description: "garden venue",
  categories: ["venue"],
  locationText: "Sydney",
  priceBand: "$$",
  priceMinMinor: null,
  priceMaxMinor: null,
  website: null,
  instagram: null,
  email: "a@x.com",
  phone: null,
  inWedding: false,
};

afterEach(() => {
  cleanup();
});

describe("the vendor directory, painted", () => {
  it("draws no closed listing dialog over its filters", async () => {
    await page.viewport(1280, 800);
    authFetch.mockResolvedValue(
      new Response(JSON.stringify({ listings: [LISTING], total: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await screen.findByText("Acme Venue");
    const closed = [...document.querySelectorAll("dialog")].filter((d) => !d.open);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.map((d) => getComputedStyle(d).display)).toEqual(closed.map(() => "none"));
    for (const name of ["Category", "Keyword", "Location"]) {
      const label = screen.getByText(name, { selector: "label" });
      const r = label.getBoundingClientRect();
      expect(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)).toBe(label);
    }
  });
});
