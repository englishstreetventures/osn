import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetEnquiriesCache,
  enquiriesAccessor,
  ensureEnquiriesLoaded,
  hasCachedEnquiries,
  peekCachedEnquiries,
  setCachedEnquiries,
  invalidateEnquiries,
  upsertCachedEnquiry,
  type EnquiryListItem,
} from "../../src/lib/enquiries-store";

const item = (over: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1",
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  vendorId: "v_1",
  zapChatId: null,
  status: "open",
  createdBy: "p_1",
  quotedMinor: null,
  lastMessageAt: 1,
  createdAt: 1,
  updatedAt: 1,
  vendorName: "Blue Roses",
  category: "florals",
  ...over,
});

beforeEach(() => __resetEnquiriesCache());

describe("enquiries-store", () => {
  it("caches and reads back per wedding", () => {
    setCachedEnquiries("wed_1", [item()]);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(1);
    expect(enquiriesAccessor("wed_1")()![0]!.vendorName).toBe("Blue Roses");
  });

  it("ensureEnquiriesLoaded fetches once and dedups concurrent calls", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return [item()];
    };
    await Promise.all([
      ensureEnquiriesLoaded("wed_1", fetcher),
      ensureEnquiriesLoaded("wed_1", fetcher),
    ]);
    expect(calls).toBe(1);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(1);
  });

  it("upsertCachedEnquiry replaces by id and prepends new ones", () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1", status: "open" })]);
    upsertCachedEnquiry("wed_1", item({ id: "enq_1", status: "quoted", quotedMinor: 5000 }));
    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    const rows = peekCachedEnquiries("wed_1")!;
    expect(rows.find((r) => r.id === "enq_1")!.status).toBe("quoted");
    expect(rows.map((r) => r.id)).toContain("enq_2");
  });

  it("invalidateEnquiries clears the cache so a reload refetches", async () => {
    setCachedEnquiries("wed_1", [item()]);
    invalidateEnquiries("wed_1");
    let calls = 0;
    await ensureEnquiriesLoaded("wed_1", async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(1);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted inbox captures that accessor at mount. Deleting the map
   * entry on invalidate would leave that accessor pointed at a signal nothing
   * writes to again — a dead view showing stale rows forever. The fix writes
   * THROUGH the signal, so an accessor captured before invalidate still
   * observes it.
   *
   * What changed since: invalidate used to null that signal outright, which
   * flashed the inbox empty on every mutation while the background refetch
   * ran. It now leaves the rows in place and marks the wedding `stale`
   * instead — a mounted inbox keeps rendering the last-known rows across the
   * invalidate.
   */
  it("a mounted consumer's captured accessor keeps the previous rows after invalidate", () => {
    setCachedEnquiries("wed_1", [item()]);
    const mounted = enquiriesAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).toHaveLength(1);
    invalidateEnquiries("wed_1");
    expect(mounted()).toHaveLength(1);
    expect(hasCachedEnquiries("wed_1")).toBe(false);
  });

  it("hasCachedEnquiries is false after invalidate", () => {
    setCachedEnquiries("wed_1", [item()]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
    invalidateEnquiries("wed_1");
    expect(hasCachedEnquiries("wed_1")).toBe(false);
  });

  /**
   * A fetch already in flight when the invalidate runs was issued against
   * PRE-mutation state. Clearing the signal alone would not stop its `.then`
   * writing those stale rows in afterwards — the generation bump does.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (items: EnquiryListItem[]) => void;
    const stale = new Promise<EnquiryListItem[]>((r) => {
      resolveStale = r;
    });
    const pending = ensureEnquiriesLoaded("wed_1", () => stale);

    invalidateEnquiries("wed_1");
    resolveStale([item({ id: "stale" })]);
    await pending;

    const fresh = async () => [item({ id: "fresh" })];
    await ensureEnquiriesLoaded("wed_1", fresh);

    expect(peekCachedEnquiries("wed_1")?.map((r) => r.id)).toEqual(["fresh"]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
  });

  it("upsertCachedEnquiry and peekCachedEnquiries still work after an invalidate/reload cycle", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1");
    await ensureEnquiriesLoaded("wed_1", async () => [item({ id: "enq_1" })]);
    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    expect(peekCachedEnquiries("wed_1")?.map((r) => r.id)).toContain("enq_2");
  });

  /**
   * The `.finally` that clears the in-flight slot is reached on a rejection
   * too — a rejected fetcher never runs the `.then`, so this is the only path
   * that exercises the guarded clear on a failed load. If the slot were left
   * populated, every later `ensureEnquiriesLoaded` would await a dead promise
   * forever instead of refetching.
   */
  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("network down");
    };
    const [a, b] = await Promise.allSettled([
      ensureEnquiriesLoaded("wed_1", failing),
      ensureEnquiriesLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1); // deduped even in failure
    expect(hasCachedEnquiries("wed_1")).toBe(false); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    let recoveringCalls = 0;
    await ensureEnquiriesLoaded("wed_1", async () => {
      recoveringCalls++;
      return [item()];
    });
    expect(recoveringCalls).toBe(1);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known inbox behind an error banner just because the
   * stale-while-revalidate contract kept the old rows on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureEnquiriesLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureEnquiriesLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(enquiriesAccessor("wed_1")()).toBeNull();
  });

  it("__resetEnquiriesCache clears the stale flag along with the cache", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1"); // marks wed_1 stale
    __resetEnquiriesCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedEnquiries` (not `ensureEnquiriesLoaded`) look like a stale
    // hit forever, since only `ensureEnquiriesLoaded`'s success path clears it.
    setCachedEnquiries("wed_1", [item({ id: "enq_2" })]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
  });
});
