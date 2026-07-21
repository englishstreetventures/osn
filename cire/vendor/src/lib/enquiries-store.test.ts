import { describe, expect, it, vi } from "vitest";

import {
  friendlyEnquiryError,
  getEnquiryMessages,
  listEnquiries,
  replyToEnquiry,
  submitQuote,
} from "./enquiries-store";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const baseEnquiry = {
  id: "e1",
  weddingId: "w1",
  directoryVendorId: "dv1",
  vendorId: "v1",
  zapChatId: null,
  status: "open" as const,
  createdBy: "p1",
  quotedMinor: null,
  lastMessageAt: 1700000000000,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  vendorName: "Bloom Florals",
  category: "florist",
  weddingName: "Alice & Bob",
};

describe("enquiries-store", () => {
  it("listEnquiries GETs /api/vendor/enquiries and returns body.enquiries", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ enquiries: [baseEnquiry] }));
    const result = await listEnquiries(authFetch);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("e1");
    // Assert weddingName passes through
    expect(result[0]!.weddingName).toBe("Alice & Bob");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/vendor/enquiries");
  });

  it("getEnquiryMessages GETs /api/vendor/enquiries/:id/messages and returns body.messages", async () => {
    const msg = { id: "m1", senderProfileId: "p1", body: "Hello!", createdAt: 1700000001000 };
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ messages: [msg] }));
    const result = await getEnquiryMessages(authFetch, "e1");
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("Hello!");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/vendor/enquiries/e1/messages");
  });

  it("replyToEnquiry POSTs {message} to /api/vendor/enquiries/:id/messages and returns body.message", async () => {
    const msg = { id: "m2", senderProfileId: "p1", body: "Got it!", createdAt: 1700000002000 };
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ message: msg }, 201));
    const result = await replyToEnquiry(authFetch, "e1", "Got it!");
    expect(result.id).toBe("m2");
    const call = authFetch.mock.calls[0]!;
    expect(String(call[0])).toContain("/api/vendor/enquiries/e1/messages");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ message: "Got it!" });
  });

  it("submitQuote POSTs {amountMinor, note} when note is defined and returns body.enquiry", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ enquiry: { ...baseEnquiry, status: "quoted", quotedMinor: 150000 } }, 201),
      );
    const result = await submitQuote(authFetch, "e1", 150000, "Includes setup");
    expect(result.status).toBe("quoted");
    expect(result.quotedMinor).toBe(150000);
    const call = authFetch.mock.calls[0]!;
    expect(String(call[0])).toContain("/api/vendor/enquiries/e1/quote");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ amountMinor: 150000, note: "Includes setup" });
  });

  it("submitQuote omits note when undefined", async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ enquiry: { ...baseEnquiry, status: "quoted", quotedMinor: 200000 } }, 201),
      );
    await submitQuote(authFetch, "e1", 200000);
    const body = JSON.parse(authFetch.mock.calls[0]![1].body);
    expect(body).toEqual({ amountMinor: 200000 });
    expect("note" in body).toBe(false);
  });

  it("listEnquiries throws the server error string on non-2xx", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "enquiry_not_found" }, 404));
    await expect(listEnquiries(authFetch)).rejects.toThrow(/enquiry_not_found/);
  });

  it("replyToEnquiry throws the server error string on non-2xx", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "enquiry_closed" }, 422));
    await expect(replyToEnquiry(authFetch, "e1", "Hi")).rejects.toThrow(/enquiry_closed/);
  });

  it("friendlyEnquiryError maps known codes to friendly strings", () => {
    expect(friendlyEnquiryError(new Error("enquiry_closed"))).not.toBe(
      "Something went wrong. Please try again.",
    );
    expect(friendlyEnquiryError(new Error("enquiry_closed"))).toContain("closed");
  });

  it("friendlyEnquiryError falls back for unknown errors", () => {
    expect(friendlyEnquiryError(new Error("mystery_code"))).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
