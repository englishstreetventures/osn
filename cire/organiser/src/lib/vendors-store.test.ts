import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetVendorsCache,
  ensureVendorsLoaded,
  invalidateVendors,
  peekCachedVendors,
  vendorCount,
  vendorsAccessor,
  type VendorRow,
} from "./vendors-store";

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
});
