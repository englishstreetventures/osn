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
   * observes the transition.
   */
  it("a mounted consumer's captured accessor observes null after invalidate", () => {
    setCachedEnquiries("wed_1", [item()]);
    const mounted = enquiriesAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).toHaveLength(1);
    invalidateEnquiries("wed_1");
    expect(mounted()).toBeNull();
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
  });

  it("upsertCachedEnquiry and peekCachedEnquiries still work after an invalidate/reload cycle", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1");
    await ensureEnquiriesLoaded("wed_1", async () => [item({ id: "enq_1" })]);
    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    expect(peekCachedEnquiries("wed_1")?.map((r) => r.id)).toContain("enq_2");
  });
});
