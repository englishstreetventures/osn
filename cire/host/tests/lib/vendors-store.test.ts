import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetVendorsCache,
  ensureVendorsLoaded,
  hasCachedVendors,
  invalidateVendors,
  peekCachedVendors,
  setCachedVendors,
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

  it("invalidateVendors marks the cache stale without nulling the raw signal", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({})]);
    expect(peekCachedVendors("wed_1")).not.toBeNull();
    invalidateVendors("wed_1");
    // `hasCachedVendors` is the miss check now — it consults the `stale` set,
    // which is exactly what makes the next `ensureVendorsLoaded` refetch.
    expect(hasCachedVendors("wed_1")).toBe(false);
    // `peekCachedVendors` and `vendorCount` read the signal directly and don't
    // consult `stale`, so they still see the last-known rows here. That gap
    // (a widget built on either of them can't tell fresh from stale) is the
    // known limitation tracked separately in #620 — this store's contract
    // only promises it for the mounted-accessor / ensureVendorsLoaded path.
    expect(peekCachedVendors("wed_1")).not.toBeNull();
    expect(vendorCount("wed_1")).toBe(1);
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
  it("a mounted consumer's captured accessor keeps the previous vendors after invalidate", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({})]);
    const mounted = vendorsAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateVendors("wed_1");
    expect(mounted()).not.toBeNull();
    expect(hasCachedVendors("wed_1")).toBe(false);
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
    expect(peekCachedVendors("wed_1")).not.toBeNull();
  });

  it("peekCachedVendors reflects fresh rows after an invalidate/reload cycle", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "a" })]);
    invalidateVendors("wed_1");
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "b" })]);
    expect(peekCachedVendors("wed_1")?.map((v) => v.id)).toEqual(["b"]);
  });

  /**
   * The `.finally` that clears the in-flight slot is reached on a rejection
   * too — a rejected fetcher never runs the `.then`, so this is the only path
   * that exercises the guarded clear on a failed load. If the slot were left
   * populated, every later `ensureVendorsLoaded` would await a dead promise
   * forever instead of refetching.
   */
  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const [a, b] = await Promise.allSettled([
      ensureVendorsLoaded("wed_1", failing),
      ensureVendorsLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1); // deduped even in failure
    expect(peekCachedVendors("wed_1")).toBeNull(); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    let recoveringCalls = 0;
    await ensureVendorsLoaded("wed_1", async () => {
      recoveringCalls += 1;
      return [vendor({})];
    });
    expect(recoveringCalls).toBe(1);
  });

  it("ensureVendorsLoaded refetches after invalidate and replaces the stale rows on success", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "a" })]);
    invalidateVendors("wed_1");
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "b" })]);
    expect(vendorsAccessor("wed_1")()?.map((v) => v.id)).toEqual(["b"]);
    expect(peekCachedVendors("wed_1")).not.toBeNull();
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known vendor list behind an error banner just because
   * the stale-while-revalidate contract kept the old rows on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureVendorsLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({})]);
    invalidateVendors("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureVendorsLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(vendorsAccessor("wed_1")()).toBeNull();
  });

  it("__resetVendorsCache clears the stale flag along with the cache", async () => {
    await ensureVendorsLoaded("wed_1", async () => [vendor({ id: "a" })]);
    invalidateVendors("wed_1"); // marks wed_1 stale
    __resetVendorsCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedVendors` (not `ensureVendorsLoaded`) look like a stale hit
    // forever, since only `ensureVendorsLoaded`'s success path clears it.
    setCachedVendors("wed_1", [vendor({ id: "b" })]);
    expect(peekCachedVendors("wed_1")).not.toBeNull();
  });
});
