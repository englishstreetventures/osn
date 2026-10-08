import { describe, expect, it } from "bun:test";

import {
  decodeEnquiryCursor,
  encodeEnquiryCursor,
  ENQUIRY_PAGE_MAX,
  parseEnquiryPage,
} from "../../src/lib/enquiry-page";

describe("encodeEnquiryCursor / decodeEnquiryCursor", () => {
  it("round-trips a row's key in the column's own unit, epoch seconds", () => {
    const cursor = encodeEnquiryCursor({
      id: "enq_0f3c",
      lastMessageAt: new Date("2026-07-20T10:00:00.900Z"),
    });
    expect(cursor).toBe(`${Date.UTC(2026, 6, 20, 10) / 1000}.enq_0f3c`);
    expect(decodeEnquiryCursor(cursor)).toEqual({
      lastMessageAt: Date.UTC(2026, 6, 20, 10) / 1000,
      id: "enq_0f3c",
    });
  });

  it("keeps everything after the first dot as the id", () => {
    expect(decodeEnquiryCursor("12.a.b")).toEqual({ lastMessageAt: 12, id: "a.b" });
  });

  it.each([
    ["no separator", "1784541600"],
    ["no seconds", ".enq_1"],
    ["no id", "1784541600."],
    ["seconds that are not digits", "-5.enq_1"],
    ["seconds padded with a space", " 15.enq_1"],
    ["seconds past the safe integer range", "9007199254740993.enq_1"],
    ["an over-long cursor", `1.${"x".repeat(250)}`],
    ["an empty string", ""],
  ])("refuses %s", (_label, raw) => {
    expect(decodeEnquiryCursor(raw)).toBeNull();
  });
});

describe("parseEnquiryPage", () => {
  it("asks for a full first page when the query names nothing", () => {
    expect(parseEnquiryPage({})).toEqual({ limit: ENQUIRY_PAGE_MAX, after: null });
    expect(parseEnquiryPage(undefined)).toEqual({ limit: ENQUIRY_PAGE_MAX, after: null });
  });

  it("never asks for more than a page, however large the limit", () => {
    expect(parseEnquiryPage({ limit: "999" })?.limit).toBe(ENQUIRY_PAGE_MAX);
    expect(parseEnquiryPage({ limit: "9".repeat(400) })?.limit).toBe(ENQUIRY_PAGE_MAX);
  });

  it("takes a smaller limit as asked, and at least one row", () => {
    expect(parseEnquiryPage({ limit: "7" })?.limit).toBe(7);
    expect(parseEnquiryPage({ limit: "0" })?.limit).toBe(1);
  });

  it("reads a limit that is not plain digits as a full page", () => {
    for (const limit of ["-3", "1e3", "0x10", "ten", ["5", "6"]]) {
      expect(parseEnquiryPage({ limit })?.limit).toBe(ENQUIRY_PAGE_MAX);
    }
  });

  it("decodes the cursor", () => {
    expect(parseEnquiryPage({ cursor: "100.enq_9", limit: "2" })).toEqual({
      limit: 2,
      after: { lastMessageAt: 100, id: "enq_9" },
    });
  });

  // A garbage cursor read as page one would hand the portal page one again to
  // append under the rows it already shows.
  it("refuses a malformed cursor rather than starting again from page one", () => {
    expect(parseEnquiryPage({ cursor: "not-a-cursor" })).toBeNull();
    expect(parseEnquiryPage({ cursor: "" })).toBeNull();
    expect(parseEnquiryPage({ cursor: ["1.a", "2.b"] })).toBeNull();
  });
});
