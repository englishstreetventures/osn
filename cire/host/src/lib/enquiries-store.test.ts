import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetEnquiriesCache,
  enquiriesAccessor,
  ensureEnquiriesLoaded,
  peekCachedEnquiries,
  setCachedEnquiries,
  invalidateEnquiries,
  upsertCachedEnquiry,
  type EnquiryListItem,
} from "./enquiries-store";

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
});
