import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetVendorsCache,
  ensureVendorsLoaded,
  invalidateVendors,
  peekCachedVendors,
  vendorCount,
  vendorsAccessor,
  type VendorRow,
} from "../../src/lib/vendors-store";

const vendor = (over: Partial<VendorRow>): VendorRow => ({
  id: "ven_1",
  weddingId: "wed_1",
  directoryVendorId: null,
  name: "Florist",
  category: "florals",
  status: "researching",
  contactName: null,
  email: null,
  phone: null,
  notes: null,
  quotedMinor: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => __resetVendorsCache());

describe("vendors-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [vendor({})];
    };
    await ensureVendorsLoaded("wed_1", fetcher);
    await ensureVendorsLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(vendorsAccessor("wed_1")()?.length).toBe(1);
  });

  it("vendorCount is null before load, then the row count", async () => {
    expect(vendorCount("wed_1")).toBeNull();
    await ensureVendorsLoaded("wed_1", async () => [
      vendor({ id: "a" }),
      vendor({ id: "b" }),
      vendor({ id: "c" }),
    ]);
    expect(vendorCount("wed_1")).toBe(3);
  });

  it("invalidateVendors clears the cache", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({})]);
    expect(peekCachedVendors("wed_1")).not.toBeNull();
    invalidateVendors("wed_1");
    expect(peekCachedVendors("wed_1")).toBeNull();
    expect(vendorCount("wed_1")).toBeNull();
  });

  it("inflight deduplication: two concurrent calls fire fetcher once", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [vendor({})];
    };
    // Fire both before either resolves.
    const [p1, p2] = [ensureVendorsLoaded("wed_2", fetcher), ensureVendorsLoaded("wed_2", fetcher)];
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted Vendors view captures that accessor at mount. Deleting the
   * map entry on invalidate would leave that accessor pointed at a signal
   * nothing writes to again — a dead view showing stale rows forever. The fix
   * writes THROUGH the signal, so an accessor captured before invalidate
   * still observes the transition.
   */
  it("a mounted consumer's captured accessor observes null after invalidate", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({})]);
    const mounted = vendorsAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateVendors("wed_1");
    expect(mounted()).toBeNull();
  });

  /**
   * A fetch already in flight when the invalidate runs was issued against
   * PRE-mutation state. Clearing the signal alone would not stop its `.then`
   * writing those stale rows in afterwards — the generation bump does.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (rows: VendorRow[]) => void;
    const stale = new Promise<VendorRow[]>((r) => {
      resolveStale = r;
    });
    const pending = ensureVendorsLoaded("wed_1", () => stale);

    invalidateVendors("wed_1");
    resolveStale([vendor({ id: "stale" })]);
    await pending;

    const fresh = async () => [vendor({ id: "fresh" })];
    await ensureVendorsLoaded("wed_1", fresh);

    expect(vendorsAccessor("wed_1")()?.map((v) => v.id)).toEqual(["fresh"]);
  });

  it("peekCachedVendors reflects fresh rows after an invalidate/reload cycle", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "a" })]);
    invalidateVendors("wed_1");
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "b" })]);
    expect(peekCachedVendors("wed_1")?.map((v) => v.id)).toEqual(["b"]);
  });
});
