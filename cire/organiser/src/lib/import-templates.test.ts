import { describe, expect, it } from "vitest";

import {
  EVENT_TEMPLATE_HEADERS,
  GUEST_TEMPLATE_FIXED_HEADERS,
  GUEST_TEMPLATE_EXAMPLE_EVENTS,
  buildEventsTemplateCsv,
  buildGuestsTemplateCsv,
} from "./import-templates";

/**
 * These constants + builders are the client-side mirror of the cire-api CSV
 * parser (`cire/api/src/services/spreadsheet.ts`). The tests assert the headers
 * the templates emit stay byte-for-byte in lockstep with what the parser
 * requires, so a column rename on either side fails loudly here.
 */

const firstLine = (csv: string) => csv.split("\r\n")[0]!;
const lines = (csv: string) => csv.split("\r\n");

describe("events template", () => {
  it("emits the required + optional event headers, in parser order, as the first row", () => {
    expect(firstLine(buildEventsTemplateCsv())).toBe(
      "Event Name,Start,Timezone,End,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
    );
  });

  it("starts with the three REQUIRED parser columns (End + Location are optional)", () => {
    expect(EVENT_TEMPLATE_HEADERS.slice(0, 3)).toEqual(["Event Name", "Start", "Timezone"]);
  });

  it("shows a blank optional End cell in one example row (open-ended event)", () => {
    const rows = lines(buildEventsTemplateCsv());
    // Row 2 (Reception) leaves End blank: "...,Australia/Sydney,,The Grounds..."
    expect(rows[2]).toContain("Australia/Sydney,,");
  });

  it("includes at least one illustrative example row with an ISO-8601 offset start", () => {
    const rows = lines(buildEventsTemplateCsv());
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The example Start cell is a real ISO-8601 string with a UTC offset.
    expect(rows[1]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    // An IANA timezone appears somewhere in the example row.
    expect(rows[1]).toContain("Australia/Sydney");
  });

  it("quotes example fields that contain commas (e.g. the address)", () => {
    // A bare comma outside quotes would split into an extra column; the address
    // example contains commas, so it must be wrapped in double quotes.
    const csv = buildEventsTemplateCsv();
    expect(csv).toMatch(/"[^"]*,[^"]*"/);
  });
});

describe("guests template", () => {
  it("emits the required + optional guest columns followed by the example event columns", () => {
    expect(firstLine(buildGuestsTemplateCsv())).toBe(
      "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname,Ceremony,Reception",
    );
  });

  it("starts with the four REQUIRED parser columns", () => {
    expect(GUEST_TEMPLATE_FIXED_HEADERS).toEqual([
      "Family ID",
      "Family Name",
      "Guest First Name",
      "Guest Last Name",
    ]);
  });

  it("uses Ceremony + Reception as placeholder event columns", () => {
    expect(GUEST_TEMPLATE_EXAMPLE_EVENTS).toEqual(["Ceremony", "Reception"]);
  });

  it("groups two example guests under one shared Family ID", () => {
    const rows = lines(buildGuestsTemplateCsv()).filter((r) => r.length > 0);
    expect(rows.length).toBeGreaterThanOrEqual(3); // header + 2 guests
    const famA = rows[1]!.split(",")[0];
    const famB = rows[2]!.split(",")[0];
    expect(famA).toBe(famB);
  });

  it("uses a parser-truthy value (x/yes/true/1) in at least one invite cell", () => {
    const csv = buildGuestsTemplateCsv().toLowerCase();
    expect(/[,]\s*(x|yes|true|1)\s*[,\r]/.test(csv)).toBe(true);
  });
});
