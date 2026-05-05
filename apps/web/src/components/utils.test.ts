import { describe, it, expect } from "vitest";
import { formatDate, parseMembers, isValidClaimResponse } from "./utils";

describe("formatDate", () => {
  it("formats a date string to en-AU long format", () => {
    const result = formatDate("2026-09-20");
    expect(result).toContain("September");
    expect(result).toContain("2026");
    expect(result).toContain("20");
  });

  it("includes the weekday", () => {
    // 2026-09-20 is a Sunday
    expect(formatDate("2026-09-20")).toContain("Sunday");
  });

  it("handles single-digit days", () => {
    const result = formatDate("2026-09-01");
    expect(result).toContain("1");
    expect(result).toContain("September");
  });

  it("handles different months", () => {
    expect(formatDate("2026-01-15")).toContain("January");
    expect(formatDate("2026-12-25")).toContain("December");
  });
});

describe("parseMembers", () => {
  it("returns a single name as a one-element array", () => {
    expect(parseMembers("Priya Sharma")).toEqual(["Priya Sharma"]);
  });

  it("splits a couple name on ampersand", () => {
    expect(parseMembers("James & Emma Wilson")).toEqual(["James", "Emma Wilson"]);
  });

  it("trims whitespace around names", () => {
    expect(parseMembers("Alice  &  Bob")).toEqual(["Alice", "Bob"]);
  });

  it("handles multiple ampersands", () => {
    expect(parseMembers("A & B & C")).toEqual(["A", "B", "C"]);
  });

  it("filters out empty strings from leading/trailing ampersands", () => {
    expect(parseMembers("& Alice &")).toEqual(["Alice"]);
  });

  it("handles a name with no ampersand", () => {
    expect(parseMembers("Auntie Meena")).toEqual(["Auntie Meena"]);
  });
});

describe("isValidClaimResponse", () => {
  const validResponse = {
    guestName: "Priya Sharma",
    events: [
      {
        id: "mehndi",
        name: "Mehndi",
        date: "2026-09-18",
        location: "The Sharma Residence",
        description: "An evening of henna",
      },
    ],
  };

  it("accepts a valid response", () => {
    expect(isValidClaimResponse(validResponse)).toBe(true);
  });

  it("accepts a response with empty events array", () => {
    expect(isValidClaimResponse({ guestName: "Test", events: [] })).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidClaimResponse(null)).toBe(false);
  });

  it("rejects a string", () => {
    expect(isValidClaimResponse("hello")).toBe(false);
  });

  it("rejects missing guestName", () => {
    expect(isValidClaimResponse({ events: [] })).toBe(false);
  });

  it("rejects non-string guestName", () => {
    expect(isValidClaimResponse({ guestName: 123, events: [] })).toBe(false);
  });

  it("rejects missing events", () => {
    expect(isValidClaimResponse({ guestName: "Test" })).toBe(false);
  });

  it("rejects non-array events", () => {
    expect(isValidClaimResponse({ guestName: "Test", events: "not-array" })).toBe(false);
  });

  it("rejects events with missing id", () => {
    expect(
      isValidClaimResponse({
        guestName: "Test",
        events: [{ name: "X", date: "2026-01-01", location: "Y" }],
      }),
    ).toBe(false);
  });

  it("rejects events with missing name", () => {
    expect(
      isValidClaimResponse({
        guestName: "Test",
        events: [{ id: "x", date: "2026-01-01", location: "Y" }],
      }),
    ).toBe(false);
  });

  it("rejects events with non-string date", () => {
    expect(
      isValidClaimResponse({
        guestName: "Test",
        events: [{ id: "x", name: "X", date: 123, location: "Y" }],
      }),
    ).toBe(false);
  });
});
