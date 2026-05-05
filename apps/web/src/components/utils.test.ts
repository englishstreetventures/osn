import { describe, it, expect } from "vitest";
import { formatDate, isValidClaimResponse } from "./utils";

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

describe("isValidClaimResponse", () => {
  const validResponse = {
    publicId: "SHARMA-JOY-RK97",
    familyName: "Sharma",
    members: [
      { firstName: "Priya", lastName: "Sharma", eventIds: ["mehndi", "reception"] },
      { firstName: "Raj", lastName: "Sharma", eventIds: ["reception"] },
    ],
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

  it("accepts a response with empty members and events arrays", () => {
    expect(
      isValidClaimResponse({
        publicId: "TEST-ABC-XY12",
        familyName: "Test",
        members: [],
        events: [],
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidClaimResponse(null)).toBe(false);
  });

  it("rejects a string", () => {
    expect(isValidClaimResponse("hello")).toBe(false);
  });

  it("rejects missing publicId", () => {
    expect(isValidClaimResponse({ familyName: "Test", members: [], events: [] })).toBe(false);
  });

  it("rejects non-string publicId", () => {
    expect(
      isValidClaimResponse({ publicId: 123, familyName: "Test", members: [], events: [] }),
    ).toBe(false);
  });

  it("rejects missing familyName", () => {
    expect(isValidClaimResponse({ publicId: "X", members: [], events: [] })).toBe(false);
  });

  it("rejects non-string familyName", () => {
    expect(isValidClaimResponse({ publicId: "X", familyName: 42, members: [], events: [] })).toBe(
      false,
    );
  });

  it("rejects missing members", () => {
    expect(isValidClaimResponse({ publicId: "X", familyName: "Test", events: [] })).toBe(false);
  });

  it("rejects non-array members", () => {
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: "nope", events: [] }),
    ).toBe(false);
  });

  it("rejects missing events", () => {
    expect(isValidClaimResponse({ publicId: "X", familyName: "Test", members: [] })).toBe(false);
  });

  it("rejects non-array events", () => {
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: [], events: "not-array" }),
    ).toBe(false);
  });

  it("rejects members with missing firstName", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ lastName: "Doe", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with missing lastName", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ firstName: "Jane", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with non-array eventIds", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ firstName: "Jane", lastName: "Doe", eventIds: "bad" }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects events with missing id", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ name: "X", date: "2026-01-01", location: "Y" }],
      }),
    ).toBe(false);
  });

  it("rejects events with missing name", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ id: "x", date: "2026-01-01", location: "Y" }],
      }),
    ).toBe(false);
  });

  it("rejects events with non-string date", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ id: "x", name: "X", date: 123, location: "Y" }],
      }),
    ).toBe(false);
  });
});
