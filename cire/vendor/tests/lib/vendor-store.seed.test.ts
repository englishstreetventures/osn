// @vitest-environment happy-dom
//
// The claim-to-editor handoff is the one part of `vendor-store.ts` that needs a
// DOM: it lives in `sessionStorage`, which the package's default `node`
// environment does not provide. Split into its own file rather than switching
// the whole of `vendor-store.test.ts` over, so the fetch-shaped tests there keep
// running in the environment they were written for.
//
// Storage failures are simulated by stubbing the `sessionStorage` global, never
// by spying on it. happy-dom's `Storage` is a Proxy: a spy on
// `Storage.prototype` stops reaching the instance once a method has been read,
// so a "throws" test passes without anything having thrown, and a spy on the
// instance is never removed by `mockRestore`, so it leaks into every later
// test. Each stubbed method is a `vi.fn`, and each test asserts it was called.
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  drainClaimedListing,
  type Listing,
  seedClaimedListing,
  takeSeededListing,
} from "../../src/lib/vendor-store";

describe("claimed-listing handoff", () => {
  const CLAIMED_LISTING_KEY = "cire.vendor.claimed-listing";

  const listing: Listing = {
    id: "dv1",
    ownerOrgId: "o1",
    name: "Rosewood Barn",
    description: null,
    email: "hello@rosewood.example",
    phone: "0400 000 000",
    website: null,
    instagram: null,
    locationText: "Hunter Valley",
    priceBand: "$$",
    priceMinMinor: null,
    priceMaxMinor: null,
    listed: "live",
    categories: ["venue"],
    createdAt: 1,
    updatedAt: 2,
  };

  /** Stand in for `sessionStorage`, delegating to it except where `failing` says. */
  function stubStorage(failing: "getItem" | "setItem" | "removeItem"): Mock {
    const real = sessionStorage;
    const thrower = vi.fn(() => {
      throw new Error("blocked");
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => real.setItem(key, value),
      removeItem: (key: string) => real.removeItem(key),
      [failing]: thrower,
    });
    return thrower;
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    // Drop whatever an earlier test left held in memory.
    drainClaimedListing();
  });

  describe("drainClaimedListing", () => {
    it("removes the key from sessionStorage at once, with no editor involved", () => {
      seedClaimedListing("o1", listing);
      expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).not.toBeNull();

      drainClaimedListing();

      expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).toBeNull();
    });

    it("removes the key even when its value is unusable", () => {
      sessionStorage.setItem(CLAIMED_LISTING_KEY, "{not json");
      drainClaimedListing();
      expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).toBeNull();
    });

    it("replaces what it held with what storage holds now", () => {
      seedClaimedListing("o1", listing);
      drainClaimedListing();
      // A second drain with nothing in storage leaves nothing held.
      drainClaimedListing();
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    it("does not throw when sessionStorage throws on read, and holds nothing", () => {
      seedClaimedListing("o1", listing);
      const getItem = stubStorage("getItem");

      expect(() => drainClaimedListing()).not.toThrow();

      expect(getItem).toHaveBeenCalled();
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    it("does not throw when sessionStorage throws on removal, and holds nothing", () => {
      seedClaimedListing("o1", listing);
      const removeItem = stubStorage("removeItem");

      expect(() => drainClaimedListing()).not.toThrow();

      expect(removeItem).toHaveBeenCalled();
      // One `try` covers both storage calls: a seed that could not be removed
      // is not handed on either.
      expect(takeSeededListing("o1")).toBeUndefined();
    });
  });

  describe("takeSeededListing", () => {
    it("round-trips a seeded listing for the org it was seeded under", () => {
      seedClaimedListing("o1", listing);
      drainClaimedListing();
      expect(takeSeededListing("o1")).toEqual(listing);
    });

    it("hands the listing over once, so a second editor mount refetches", () => {
      seedClaimedListing("o1", listing);
      drainClaimedListing();
      takeSeededListing("o1");
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    it("refuses a seed held for a different org, and drops it anyway", () => {
      seedClaimedListing("o1", listing);
      drainClaimedListing();
      expect(takeSeededListing("o2")).toBeUndefined();
      // Dropped on a mismatch too, so a stale seed cannot sit waiting for the
      // org it happens to name to be opened later.
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    it("never reads sessionStorage itself, so only a drain can hand a seed on", () => {
      seedClaimedListing("o1", listing);
      expect(takeSeededListing("o1")).toBeUndefined();
      expect(sessionStorage.getItem(CLAIMED_LISTING_KEY)).not.toBeNull();
    });

    it("returns undefined when nothing was seeded", () => {
      drainClaimedListing();
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    it("returns undefined on unparseable JSON", () => {
      sessionStorage.setItem(CLAIMED_LISTING_KEY, "{not json");
      drainClaimedListing();
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    // `drainClaimedListing` runs at the top of the dashboard island with nothing
    // above it to catch, so no JSON value, however odd, may make it throw.
    it.each([
      ["null", "null"],
      ["a number", "42"],
      ["a string", '"o1"'],
      ["an object with a null listing", JSON.stringify({ orgId: "o1", listing: null })],
      ["an object with a numeric listing", JSON.stringify({ orgId: "o1", listing: 7 })],
    ])("holds nothing, without throwing, when the stored value parses to %s", (_label, raw) => {
      sessionStorage.setItem(CLAIMED_LISTING_KEY, raw);
      expect(() => drainClaimedListing()).not.toThrow();
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    it.each([
      ["missing", { listing }],
      ["not a string", { orgId: 7, listing }],
    ])("rejects a seed whose orgId is %s", (_label, seed) => {
      sessionStorage.setItem(CLAIMED_LISTING_KEY, JSON.stringify(seed));
      drainClaimedListing();
      expect(takeSeededListing("o1")).toBeUndefined();
    });

    // Every field `Listing` declares as required and non-nullable is
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
        drainClaimedListing();
        expect(takeSeededListing("o1")).toBeUndefined();
      },
    );

    it("rejects a seed whose categories are not all strings", () => {
      sessionStorage.setItem(
        CLAIMED_LISTING_KEY,
        JSON.stringify({ orgId: "o1", listing: { ...listing, categories: ["venue", 7] } }),
      );
      drainClaimedListing();
      expect(takeSeededListing("o1")).toBeUndefined();
    });
  });

  describe("seedClaimedListing", () => {
    it("keeps its nerve when sessionStorage throws on write", () => {
      const setItem = stubStorage("setItem");

      expect(() => seedClaimedListing("o1", listing)).not.toThrow();

      expect(setItem).toHaveBeenCalled();
    });
  });
});
