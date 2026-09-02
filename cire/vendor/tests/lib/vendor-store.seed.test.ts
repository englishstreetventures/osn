// @vitest-environment happy-dom
//
// The claim-to-editor handoff is the one part of `vendor-store.ts` that needs a
// DOM: it lives entirely in `sessionStorage`, which the package's default
// `node` environment does not provide. Split into its own file rather than
// switching the whole of `vendor-store.test.ts` over, so the fetch-shaped tests
// there keep running in the environment they were written for.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type Listing, seedClaimedListing, takeSeededListing } from "../../src/lib/vendor-store";

describe("claimed-listing handoff (VP-P-W2)", () => {
  const CLAIMED_LISTING_KEY = "cire.vendor.claimed-listing";

  const listing: Listing = {
    id: "dv1",
    ownerOrgId: "o1",
    name: "Rosewood Barn",
    description: null,
    email: null,
    phone: null,
    website: null,
    instagram: null,
    locationText: null,
    priceBand: null,
    priceMinMinor: null,
    priceMaxMinor: null,
    listed: "live",
    categories: ["venue"],
    createdAt: 1,
    updatedAt: 2,
  };

  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a seeded listing for the org it was seeded under", () => {
    seedClaimedListing("o1", listing);
    expect(takeSeededListing("o1")).toEqual(listing);
  });

  it("consumes the key on read, so a second editor mount refetches", () => {
    seedClaimedListing("o1", listing);
    takeSeededListing("o1");
    expect(takeSeededListing("o1")).toBeUndefined();
    expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).toBeNull();
  });

  it("refuses a seed left by a different org, and consumes it anyway", () => {
    seedClaimedListing("o1", listing);
    expect(takeSeededListing("o2")).toBeUndefined();
    // Consumed on the way out even on a mismatch, so a stale seed cannot sit
    // waiting for the org it happens to name to be opened later.
    expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).toBeNull();
  });

  it("returns undefined when nothing was seeded", () => {
    expect(takeSeededListing("o1")).toBeUndefined();
  });

  it("returns undefined on unparseable JSON", () => {
    sessionStorage.setItem(CLAIMED_LISTING_KEY, "{not json");
    expect(takeSeededListing("o1")).toBeUndefined();
  });

  // S-L1: every field `Listing` declares as required and non-nullable is
  // checked, because `ListingEditor` renders `listed` straight into the status
  // chip — a seed without it would put the word "undefined" on screen.
  it.each(["id", "name", "listed", "categories", "createdAt", "updatedAt"] as const)(
    "rejects a seed missing the required field %s",
    (field) => {
      const partial: Record<string, unknown> = { ...listing };
      delete partial[field];
      sessionStorage.setItem(
        CLAIMED_LISTING_KEY,
        JSON.stringify({ orgId: "o1", listing: partial }),
      );
      expect(takeSeededListing("o1")).toBeUndefined();
    },
  );

  it("rejects a seed whose categories are not all strings", () => {
    sessionStorage.setItem(
      CLAIMED_LISTING_KEY,
      JSON.stringify({ orgId: "o1", listing: { ...listing, categories: ["venue", 7] } }),
    );
    expect(takeSeededListing("o1")).toBeUndefined();
  });

  it("keeps its nerve when sessionStorage throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => seedClaimedListing("o1", listing)).not.toThrow();
  });

  it("falls through to undefined when sessionStorage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(takeSeededListing("o1")).toBeUndefined();
  });

  it("still returns the listing when only the removal throws", () => {
    seedClaimedListing("o1", listing);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(takeSeededListing("o1")).toEqual(listing);
  });
});
