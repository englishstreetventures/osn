import type { Event } from "@pulse/db/schema";
import { describe, it, expect } from "vitest";

import { buildIcs } from "../../src/services/calendar";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt_cal_test",
    title: "Test Event",
    description: null,
    location: null,
    venue: null,
    venueId: null,
    latitude: null,
    longitude: null,
    category: null,
    startTime: new Date("2030-06-01T10:00:00.000Z"),
    endTime: null,
    status: "upcoming",
    imageUrl: null,
    priceAmount: null,
    priceCurrency: null,
    visibility: "public",
    guestListVisibility: "public",
    joinPolicy: "open",
    allowInterested: true,
    commsChannels: '["email"]',
    chatId: null,
    seriesId: null,
    instanceOverride: false,
    createdByProfileId: "usr_alice",
    createdByName: "Alice",
    createdByAvatar: null,
    cancelledAt: null,
    hardDeleteAt: null,
    cancellationReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Undo 75-octet folding, so a test can assert on a whole property value. */
function unfold(ics: string): string {
  return ics.replaceAll("\r\n ", "");
}

describe("buildIcs", () => {
  it("emits a well-formed VCALENDAR + VEVENT", () => {
    const ics = buildIcs(makeEvent({ title: "Concert" }));
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Concert");
    expect(ics).toContain("UID:pulse-event-evt_cal_test");
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

  it("omits DTEND when the event has no end time", () => {
    const ics = buildIcs(
      makeEvent({
        startTime: new Date("2030-06-01T10:00:00.000Z"),
        endTime: null,
      }),
    );
    // RFC 5545 §3.6.1 allows a VEVENT with DTSTART and no DTEND. A default
    // duration would show the guest a finish time the host never set.
    expect(ics).not.toContain("DTEND");
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

  it("folds lines longer than 75 octets per RFC 5545", () => {
    const longTitle = "A".repeat(200);
    const ics = buildIcs(makeEvent({ title: longTitle }));
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // Folding is a transport detail — unfolding gives the value back whole.
    expect(unfold(ics)).toContain(`SUMMARY:${longTitle}`);
  });

  // The limit counts octets, so a line of emoji must break four times sooner
  // than a line of ASCII — and never through a character.
  it("counts octets, not string length, when folding", () => {
    const title = "🎉".repeat(40);
    const ics = buildIcs(makeEvent({ title }));
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(ics)).toContain(`SUMMARY:${title}`);
    // A fold through a surrogate pair would leave a replacement character
    // behind once the file round-trips through UTF-8.
    expect(ics).not.toContain("�");
  });

  it("marks a cancelled event CANCELLED", () => {
    expect(buildIcs(makeEvent())).toContain("STATUS:CONFIRMED");
    expect(buildIcs(makeEvent({ status: "cancelled" }))).toContain("STATUS:CANCELLED");
  });

  it("carries the category when the event has one", () => {
    expect(buildIcs(makeEvent({ category: "music" }))).toContain("CATEGORIES:music");
    expect(buildIcs(makeEvent())).not.toContain("CATEGORIES:");
  });
});
