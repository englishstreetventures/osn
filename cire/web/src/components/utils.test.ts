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
  const baseEvent = {
    id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
    name: "Mehndi",
    date: "2026-09-18",
    location: "The Sharma Residence",
    description: "An evening of henna",
    startAt: "2026-09-18T16:00:00+10:00",
    endAt: "2026-09-18T22:00:00+10:00",
    timezone: "Australia/Sydney",
    address: "12 Banksia Lane, Strathfield",
    dressCodeDescription: "Bright, festive colours",
    dressCodePalette: [{ name: "Marigold", color: "oklch(76% 0.15 75)" }],
    pinterestUrl: "https://www.pinterest.com/",
    mapsUrl: "https://maps.google.com/",
    sortOrder: 0,
  };

  const validResponse = {
    publicId: "SHARMA-JOY-RK97",
    familyName: "Sharma",
    members: [
      {
        guestId: "guest-1",
        firstName: "Priya",
        lastName: "Sharma",
        eventIds: ["mehndi", "reception"],
      },
      { guestId: "guest-2", firstName: "Raj", lastName: "Sharma", eventIds: ["reception"] },
    ],
    events: [baseEvent],
    rsvps: [{ guestId: "guest-1", eventId: "mehndi", status: "attending", dietary: "Vegetarian" }],
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
        rsvps: [],
      }),
    ).toBe(true);
  });

  it("accepts events with null optional fields", () => {
    expect(
      isValidClaimResponse({
        publicId: "T",
        familyName: "T",
        members: [],
        events: [
          {
            ...baseEvent,
            address: null,
            dressCodeDescription: null,
            dressCodePalette: null,
            pinterestUrl: null,
            mapsUrl: null,
          },
        ],
        rsvps: [],
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

  it("rejects members missing guestId", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ firstName: "Jane", lastName: "Doe", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with missing firstName", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ guestId: "g1", lastName: "Doe", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with missing lastName", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ guestId: "g1", firstName: "Jane", eventIds: [] }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects members with non-array eventIds", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [{ guestId: "g1", firstName: "Jane", lastName: "Doe", eventIds: "bad" }],
        events: [],
      }),
    ).toBe(false);
  });

  it("rejects events with missing id", () => {
    const { id: _id, ...rest } = baseEvent;
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [rest],
      }),
    ).toBe(false);
  });

  it("rejects events with missing name", () => {
    const { name: _name, ...rest } = baseEvent;
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [rest],
      }),
    ).toBe(false);
  });

  it("rejects events with non-string date", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, date: 123 }],
      }),
    ).toBe(false);
  });

  it("rejects events with missing startAt", () => {
    const { startAt: _s, ...rest } = baseEvent;
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: [], events: [rest] }),
    ).toBe(false);
  });

  it("rejects events with non-string timezone", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, timezone: 7 }],
      }),
    ).toBe(false);
  });

  it("rejects events with non-string address (other than null)", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, address: 42 }],
      }),
    ).toBe(false);
  });

  it("rejects events with malformed dressCodePalette", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, dressCodePalette: [{ name: "X" }] }],
      }),
    ).toBe(false);
  });

  it("rejects missing rsvps", () => {
    expect(
      isValidClaimResponse({ publicId: "X", familyName: "Test", members: [], events: [] }),
    ).toBe(false);
  });

  it("rejects non-array rsvps", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: "nope",
      }),
    ).toBe(false);
  });

  it("rejects rsvps with unknown status", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: [{ guestId: "g1", eventId: "e1", status: "yolo", dietary: "" }],
      }),
    ).toBe(false);
  });

  it("rejects rsvps with non-string dietary", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [],
        rsvps: [{ guestId: "g1", eventId: "e1", status: "attending", dietary: 42 }],
      }),
    ).toBe(false);
  });

  it("rejects events with non-number sortOrder", () => {
    expect(
      isValidClaimResponse({
        publicId: "X",
        familyName: "Test",
        members: [],
        events: [{ ...baseEvent, sortOrder: "0" }],
      }),
    ).toBe(false);
  });
});
