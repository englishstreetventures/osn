import { describe, it, expect } from "vitest";
import { buildIcs } from "../../src/services/calendar";
import type { Event } from "@pulse/db/schema";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt_cal_test",
    title: "Test Event",
    description: null,
    location: null,
    venue: null,
    latitude: null,
    longitude: null,
    category: null,
    startTime: new Date("2030-06-01T10:00:00.000Z"),
    endTime: null,
    status: "upcoming",
    imageUrl: null,
    visibility: "public",
    guestListVisibility: "public",
    joinPolicy: "open",
    allowInterested: true,
    commsChannels: '["email"]',
    createdByUserId: "usr_alice",
    createdByName: "Alice",
    createdByAvatar: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildIcs", () => {
  it("emits a well-formed VCALENDAR + VEVENT", () => {
    const ics = buildIcs(makeEvent({ title: "Concert" }));
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Concert");
    expect(ics).toContain("UID:evt_cal_test@pulse");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("uses CRLF line endings (RFC 5545)", () => {
    const ics = buildIcs(makeEvent());
    expect(ics.split("\r\n").length).toBeGreaterThan(5);
    expect(ics).not.toMatch(/[^\r]\n/); // no bare LF
  });

  it("formats DTSTART as UTC timestamp", () => {
    const ics = buildIcs(makeEvent({ startTime: new Date("2030-06-01T10:30:45.000Z") }));
    expect(ics).toContain("DTSTART:20300601T103045Z");
  });

  it("defaults DTEND to start + 2h when endTime is null", () => {
    const ics = buildIcs(
      makeEvent({
        startTime: new Date("2030-06-01T10:00:00.000Z"),
        endTime: null,
      }),
    );
    expect(ics).toContain("DTEND:20300601T120000Z");
  });

  it("uses explicit endTime when provided", () => {
    const ics = buildIcs(
      makeEvent({
        startTime: new Date("2030-06-01T10:00:00.000Z"),
        endTime: new Date("2030-06-01T15:00:00.000Z"),
      }),
    );
    expect(ics).toContain("DTEND:20300601T150000Z");
  });

  it("escapes commas, semicolons, and newlines in description", () => {
    const ics = buildIcs(
      makeEvent({
        description: "Line 1\nLine 2, with comma; and semicolon",
      }),
    );
    expect(ics).toContain("DESCRIPTION:Line 1\\nLine 2\\, with comma\\; and semicolon");
  });

  it("includes GEO when latitude and longitude present", () => {
    const ics = buildIcs(makeEvent({ latitude: 40.7128, longitude: -74.006 }));
    expect(ics).toContain("GEO:40.7128;-74.006");
  });

  it("omits GEO when coordinates missing", () => {
    const ics = buildIcs(makeEvent());
    expect(ics).not.toContain("GEO:");
  });

  it("combines venue and location into LOCATION field", () => {
    const ics = buildIcs(makeEvent({ venue: "The Venue", location: "123 Main St" }));
    expect(ics).toContain("LOCATION:The Venue\\, 123 Main St");
  });

  it("folds lines longer than 75 characters per RFC 5545", () => {
    const longTitle = "A".repeat(200);
    const ics = buildIcs(makeEvent({ title: longTitle }));
    // Line folding inserts CRLF + space for continuation; check that the
    // SUMMARY line has been split.
    const summaryRegion = ics.slice(ics.indexOf("SUMMARY:"));
    expect(summaryRegion.split("\r\n ").length).toBeGreaterThan(1);
  });
});
