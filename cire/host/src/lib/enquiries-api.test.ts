import { describe, expect, it, vi } from "vitest";

import {
  EnquiryApiError,
  addEnquiryToBudget,
  enquiryErrorMessage,
  fetchEnquiries,
  fetchMessages,
  openEnquiry,
  replyEnquiry,
} from "./enquiries-api";

const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("fetchEnquiries", () => {
  it("GETs the correct URL and returns body.enquiries", async () => {
    const enquiries = [
      {
        id: "enq_1",
        weddingId: "wed_1",
        directoryVendorId: "dv_1",
        vendorId: "v_1",
        zapChatId: null,
        status: "open" as const,
        createdBy: "p_1",
        quotedMinor: null,
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
        vendorName: "Blue Roses",
        category: "florals",
      },
    ];
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ enquiries }));
    const result = await fetchEnquiries(authFetch, "wed_1");
    expect(result).toEqual(enquiries);
    const [url] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/weddings\/wed_1\/enquiries$/);
    expect(authFetch.mock.calls[0]![1]).toBeUndefined();
  });
});

describe("fetchMessages", () => {
  it("GETs the correct URL and returns body.messages", async () => {
    const messages = [{ id: "msg_1", senderProfileId: "p_1", body: "hi", createdAt: 1 }];
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ messages }));
    const result = await fetchMessages(authFetch, "wed_1", "enq_1");
    expect(result).toEqual(messages);
    const [url] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/weddings\/wed_1\/enquiries\/enq_1\/messages$/);
  });

  it("throws EnquiryApiError with code vendor_chat_unavailable on 503", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "vendor_chat_unavailable" }, 503));
    await expect(fetchMessages(authFetch, "wed_1", "enq_1")).rejects.toMatchObject({
      code: "vendor_chat_unavailable",
      status: 503,
    });
  });
});

describe("openEnquiry", () => {
  it("merges vendorName/category and posts the correct body", async () => {
    const authFetch = vi.fn().mockResolvedValue(
      jsonRes(
        {
          enquiry: {
            id: "enq_9",
            weddingId: "wed_1",
            directoryVendorId: "dv_1",
            vendorId: "v_1",
            zapChatId: null,
            status: "open",
            createdBy: "p",
            quotedMinor: null,
            lastMessageAt: 5,
            createdAt: 5,
            updatedAt: 5,
          },
        },
        201,
      ),
    );
    const item = await openEnquiry(authFetch, "wed_1", {
      directoryVendorId: "dv_1",
      category: "florals",
      message: "hi",
      vendorName: "Blue Roses",
    });
    expect(item.vendorName).toBe("Blue Roses");
    expect(item.category).toBe("florals");
    expect(item.id).toBe("enq_9");
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/weddings\/wed_1\/enquiries$/);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      directoryVendorId: "dv_1",
      category: "florals",
      message: "hi",
    });
  });

  it("maps 409 awaiting_vendor to a typed error", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "awaiting_vendor" }, 409));
    await expect(
      openEnquiry(authFetch, "wed_1", {
        directoryVendorId: "dv_1",
        category: "florals",
        message: "hi",
        vendorName: "Blue Roses",
      }),
    ).rejects.toMatchObject({ code: "awaiting_vendor", status: 409 });
  });
});

describe("replyEnquiry", () => {
  it("POSTs message and returns body.message", async () => {
    const message = { id: "msg_2", senderProfileId: "p_1", body: "hello", createdAt: 2 };
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ message }, 201));
    const result = await replyEnquiry(authFetch, "wed_1", "enq_1", "hello");
    expect(result).toEqual(message);
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/weddings\/wed_1\/enquiries\/enq_1\/messages$/);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ message: "hello" });
  });

  it("maps 409 awaiting_vendor to a typed error + friendly copy", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "awaiting_vendor" }, 409));
    await expect(replyEnquiry(authFetch, "wed_1", "enq_9", "hi")).rejects.toMatchObject({
      code: "awaiting_vendor",
    });
  });

  it("maps 503 vendor_chat_unavailable to a typed error", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "vendor_chat_unavailable" }, 503));
    await expect(replyEnquiry(authFetch, "wed_1", "enq_9", "hi")).rejects.toMatchObject({
      code: "vendor_chat_unavailable",
    });
  });
});

describe("addEnquiryToBudget", () => {
  it("POSTs to add-to-budget and returns body", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ budgetItemId: "bi_1" }, 201));
    const result = await addEnquiryToBudget(authFetch, "wed_1", "enq_1");
    expect(result).toEqual({ budgetItemId: "bi_1" });
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/weddings\/wed_1\/enquiries\/enq_1\/add-to-budget$/);
    expect(init!.method).toBe("POST");
  });
});

describe("enquiryErrorMessage", () => {
  it("returns awaiting_vendor copy for that code", () => {
    const err = new EnquiryApiError("awaiting_vendor", 409);
    expect(enquiryErrorMessage(err)).toBe(
      "This vendor hasn't joined yet — they'll get your first message when they claim their listing.",
    );
  });

  it("returns vendor_chat_unavailable copy for that code", () => {
    const err = new EnquiryApiError("vendor_chat_unavailable", 503);
    expect(enquiryErrorMessage(err)).toBe(
      "Messaging is temporarily unavailable. Please try again shortly.",
    );
  });

  it("returns read_only_role copy for that code", () => {
    const err = new EnquiryApiError("read_only_role", 403);
    expect(enquiryErrorMessage(err)).toBe("You have view-only access to this wedding.");
  });

  it("returns generic copy for unknown errors", () => {
    expect(enquiryErrorMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
    expect(enquiryErrorMessage("string error")).toBe("Something went wrong. Please try again.");
  });
});
