import { describe, expect, it } from "vitest";

import {
  EVENT_TEMPLATE_HEADERS,
  GUEST_TEMPLATE_FIXED_HEADERS,
  GUEST_TEMPLATE_EXAMPLE_EVENTS,
  buildEventsTemplateCsv,
  buildGuestsTemplateCsv,
} from "../../src/lib/import-templates";

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
      "Event Name,Start,Timezone,End,Location,Address,Description,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL,Run of Show,Getting There,Children,Plus-Ones,Guest Policy Note",
    );
  });

  // cire-api's spreadsheet.test.ts ("round-trips the organiser starter
  // template") parses a copy of this exact text, so the starter sheet an
  // organiser downloads always imports. Change both together.
  it("emits exactly the template the API's parser test imports", () => {
    expect(buildEventsTemplateCsv()).toBe(
      [
        "Event Name,Start,Timezone,End,Location,Address,Description,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL,Run of Show,Getting There,Children,Plus-Ones,Guest Policy Note",
        'Ceremony,2026-11-14T15:00,Australia/Sydney,2026-11-14T16:00,St Mary\'s Cathedral,"St Marys Rd, Sydney NSW 2000, Australia",The service begins at 3 pm sharp. Please be seated by 2:45.,Formal — suits and cocktail dresses,Blush:#f4c2c2|Sage:#b2ac88,https://pinterest.com/example/ceremony,https://maps.google.com/?q=St+Marys+Cathedral+Sydney,"15:00 Processional\n15:20 Vows\n15:45 Signing of the register",Street parking on St Marys Rd. St James station is a five-minute walk.,Children welcome,By invitation,',
        'Reception,2026-11-14T18:00,Australia/Sydney,,The Grounds of Alexandria,"7A/2 Huntley St, Alexandria NSW 2015, Australia","Dinner, speeches and dancing until late.",Black tie,Midnight:#191970|Gold:#d4af37,https://pinterest.com/example/reception,https://maps.google.com/?q=The+Grounds+of+Alexandria,"18:00 Canapés\n19:30 Dinner\n21:00 Speeches\n00:30 Carriages",,Adults only,,Babes in arms are welcome.',
      ].join("\r\n"),
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

  it("shows Start as a bare LOCAL wall clock — no UTC offset, ever", () => {
    const rows = lines(buildEventsTemplateCsv());
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // `YYYY-MM-DDTHH:MM` and nothing after it. The offset the stored timestamp
    // ends up carrying is derived from the Timezone column server-side
    // (`cire/api/src/lib/event-time.ts`), so an example that showed one would be
    // asking the organiser for a number the zone already answers — the exact
    // pair of fields the events editor stopped presenting.
    expect(rows[1]).toMatch(/,\d{4}-\d{2}-\d{2}T\d{2}:\d{2},/);
    expect(rows[1]).not.toMatch(/T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})/);
    // An IANA timezone appears somewhere in the example row — that IS the
    // offset's source of truth.
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
