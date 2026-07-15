import { describe, it, expect } from "bun:test";

import { Effect } from "effect";

import {
  parseEventsCsv,
  parseGuestsCsv,
  parseCsv,
  FormulaInjectionDetected,
  MissingRequiredColumn,
  UnmatchedEventColumn,
  MalformedSpreadsheet,
} from "./spreadsheet";

const EVENTS_HEADER =
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL";

describe("parseCsv (RFC 4180)", () => {
  it("parses a simple two-column CSV", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("treats CRLF the same as LF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves quoted cells containing commas", () => {
    expect(parseCsv('a,b\n"hello, world",2')).toEqual([
      ["a", "b"],
      ["hello, world", "2"],
    ]);
  });

  it("decodes escaped double-quotes inside quoted cells", () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([["a"], [`she said "hi"`]]);
  });

  it("supports multi-line cells", () => {
    expect(parseCsv('a,b\n"line\nbreak",2')).toEqual([
      ["a", "b"],
      ["line\nbreak", "2"],
    ]);
  });

  it("preserves a trailing empty cell after a comma", () => {
    expect(parseCsv("a,b,c\n1,2,\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", ""],
    ]);
  });
});

describe("parseEventsCsv", () => {
  it("parses a happy-path events sheet with a single row", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia Lane,Bright colours,Marigold:oklch(76% 0.15 75)|Fuchsia:oklch(54% 0.21 352),https://pinterest.com/x,https://maps.google.com/?q=home",
    ].join("\n");

    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.name).toBe("Mehndi");
    expect(ev.startAt).toBe("2026-09-18T16:00:00+10:00");
    expect(ev.timezone).toBe("Australia/Sydney");
    expect(ev.address).toBe("12 Banksia Lane");
    expect(ev.dressCodePalette).toEqual([
      { name: "Marigold", color: "oklch(76% 0.15 75)" },
      { name: "Fuchsia", color: "oklch(54% 0.21 352)" },
    ]);
    expect(ev.pinterestUrl).toBe("https://pinterest.com/x");
    expect(ev.sortOrder).toBe(0);
  });

  it("supports an empty Dress Code Palette cell", async () => {
    const csv = [
      EVENTS_HEADER,
      "Wedding,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,,,,",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events[0]!.dressCodePalette).toEqual([]);
    expect(events[0]!.address).toBeNull();
  });

  it("fails when a required column is missing", async () => {
    const csv = "Event Name,End,Timezone\nMehndi,x,y";
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(MissingRequiredColumn);
    expect((error as MissingRequiredColumn).column).toBe("Start");
  });

  it("parses a sheet with no Location column (optional) — location is null", async () => {
    const csv = [
      "Event Name,Start,End,Timezone",
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events).toHaveLength(1);
    expect(events[0]!.location).toBeNull();
    expect(events[0]!.endAt).toBe("2026-09-18T22:00:00+10:00");
  });

  it("treats an empty or whitespace-only Location cell as null", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,",
      "Sangeet,2026-09-19T16:00:00+10:00,2026-09-19T22:00:00+10:00,Australia/Sydney,   ,,,,,",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events).toHaveLength(2);
    expect(events[0]!.location).toBeNull();
    expect(events[1]!.location).toBeNull();
  });

  it("parses a populated Location cell into `location`", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,,,,,",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events[0]!.location).toBe("Home");
  });

  it("parses a sheet with no End column (optional) — endAt is the '' sentinel", async () => {
    const csv = [
      "Event Name,Start,Timezone",
      "Mehndi,2026-09-18T16:00:00+10:00,Australia/Sydney",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events).toHaveLength(1);
    expect(events[0]!.endAt).toBe("");
  });

  it("treats an empty End cell as the '' no-stated-end sentinel", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,,Australia/Sydney,Home,,,,,",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events[0]!.endAt).toBe("");
    expect(events[0]!.startAt).toBe("2026-09-18T16:00:00+10:00");
  });

  // Start/End shape is load-bearing: retention compares the stored strings
  // LEXICALLY against a YYYY-MM-DD cutoff (see isIsoTimestamp in spreadsheet.ts).
  for (const bad of ["1st Nov 2026", "TBD", "18/09/2026 4pm"]) {
    it(`rejects a non-ISO Start cell (${JSON.stringify(bad)})`, async () => {
      const csv = [EVENTS_HEADER, `Mehndi,${bad},,Australia/Sydney,Home,,,,,`].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
      expect(error).toBeInstanceOf(MalformedSpreadsheet);
      expect((error as MalformedSpreadsheet).reason).toBe("Start must be an ISO-8601 timestamp");
      expect((error as MalformedSpreadsheet).row).toBe(2);
    });
  }

  it("rejects a non-blank, non-ISO End cell (blank stays legal)", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,late,Australia/Sydney,Home,,,,,",
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(MalformedSpreadsheet);
    expect((error as MalformedSpreadsheet).reason).toBe("End must be an ISO-8601 timestamp");
  });

  it("accepts ISO timestamps without seconds (the explainer's documented shape)", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-11-14T15:00+11:00,2026-11-14T22:00+11:00,Australia/Sydney,Home,,,,,",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events[0]!.startAt).toBe("2026-11-14T15:00+11:00");
    expect(events[0]!.endAt).toBe("2026-11-14T22:00+11:00");
  });

  it("rejects an event row with an empty Start cell (start is required)", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,,,,,",
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(MalformedSpreadsheet);
    expect((error as MalformedSpreadsheet).reason).toBe("Start is required");
  });

  for (const marker of ["=", "+", "-", "@"]) {
    it(`rejects formula injection prefix '${marker}' in events sheet`, async () => {
      const csv = [
        EVENTS_HEADER,
        `${marker}cmd|',2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
      expect(error).toBeInstanceOf(FormulaInjectionDetected);
      const fi = error as FormulaInjectionDetected;
      expect(fi.row).toBe(2);
      expect(fi.column).toBe(1);
      expect(fi.snippet.length).toBeLessThanOrEqual(10);
      expect(fi.snippet.startsWith(marker)).toBe(true);
    });
  }

  it("ignores fully blank trailing rows", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,,,,,",
      ",,,,,,,,,",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events).toHaveLength(1);
  });

  it("returns MalformedSpreadsheet for empty content", async () => {
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv("")));
    expect(error).toBeInstanceOf(MalformedSpreadsheet);
  });

  for (const [label, value] of [
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["non-URL", "not a url at all"],
  ] as const) {
    it(`rejects ${label} Pinterest URL`, async () => {
      const csv = [
        EVENTS_HEADER,
        `Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,,,,${value},`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
      expect(error).toBeInstanceOf(MalformedSpreadsheet);
      expect((error as MalformedSpreadsheet).reason).toBe("Pinterest URL must be an http(s) URL");
    });

    it(`rejects ${label} Maps URL`, async () => {
      const csv = [
        EVENTS_HEADER,
        `Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,,,,,${value}`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
      expect(error).toBeInstanceOf(MalformedSpreadsheet);
      expect((error as MalformedSpreadsheet).reason).toBe("Maps URL must be an http(s) URL");
    });
  }

  it("round-trips the organiser starter template (header parity + blank-End example)", async () => {
    // Byte-for-byte copy of `buildEventsTemplateCsv()` output from
    // cire/organiser/src/lib/import-templates.ts (pinned exactly there by
    // import-templates.test.ts — if the template changes, that test fails and
    // this copy must be updated in the same PR). Feeding it through the parser
    // guarantees the shipped starter CSV can never fail its own import.
    const template = [
      "Event Name,Start,Timezone,End,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
      'Ceremony,2026-11-14T15:00:00+11:00,Australia/Sydney,2026-11-14T16:00:00+11:00,St Mary\'s Cathedral,"St Marys Rd, Sydney NSW 2000, Australia",Formal — suits and cocktail dresses,Blush:#f4c2c2|Sage:#b2ac88,https://pinterest.com/example/ceremony,https://maps.google.com/?q=St+Marys+Cathedral+Sydney',
      'Reception,2026-11-14T18:00:00+11:00,Australia/Sydney,,The Grounds of Alexandria,"7A/2 Huntley St, Alexandria NSW 2015, Australia",Black tie,Midnight:#191970|Gold:#d4af37,https://pinterest.com/example/reception,https://maps.google.com/?q=The+Grounds+of+Alexandria',
    ].join("\r\n");
    const events = await Effect.runPromise(parseEventsCsv(template));
    expect(events).toHaveLength(2);
    expect(events[0]!.endAt).toBe("2026-11-14T16:00:00+11:00");
    expect(events[1]!.endAt).toBe(""); // the template's open-ended example row
    expect(events[0]!.location).toBe("St Mary's Cathedral");
    expect(events[1]!.location).toBe("The Grounds of Alexandria");
    expect(events[0]!.address).toBe("St Marys Rd, Sydney NSW 2000, Australia");
  });

  it("accepts http and https URLs", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,,,,http://pin.example/x,https://maps.example/q",
    ].join("\n");
    const events = await Effect.runPromise(parseEventsCsv(csv));
    expect(events[0]!.pinterestUrl).toBe("http://pin.example/x");
    expect(events[0]!.mapsUrl).toBe("https://maps.example/q");
  });
});

describe("parseGuestsCsv", () => {
  const events = [
    {
      name: "Mehndi",
      startAt: "x",
      endAt: "x",
      timezone: "x",
      location: "",
      address: null,
      dressCodeDescription: null,
      dressCodePalette: [],
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 0,
    },
    {
      name: "Wedding Ceremony",
      startAt: "x",
      endAt: "x",
      timezone: "x",
      location: "",
      address: null,
      dressCodeDescription: null,
      dressCodePalette: [],
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 1,
    },
  ];

  it("parses families and guests with truthy event toggles", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      "1,Testfamily,Ada,Testfamily,TRUE,yes",
      "1,Testfamily,Fenn,Testfamily,1,x",
      "2,Sampleton,Bo,Sampleton,FALSE,TRUE",
    ].join("\n");

    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families).toHaveLength(2);
    expect(families[0]!.familyName).toBe("Testfamily");
    expect(families[0]!.guests).toHaveLength(2);
    expect([...families[0]!.guests[0]!.eventNames].toSorted()).toEqual(
      ["Mehndi", "Wedding Ceremony"].toSorted(),
    );
    expect([...families[0]!.guests[1]!.eventNames].toSorted()).toEqual(
      ["Mehndi", "Wedding Ceremony"].toSorted(),
    );
    expect(families[1]!.guests[0]!.eventNames).toEqual(["Wedding Ceremony"]);
    // No Nickname column ⇒ every guest's nickname is null.
    expect(families[0]!.guests[0]!.nickname).toBeNull();
    expect(families[1]!.guests[0]!.nickname).toBeNull();
  });

  it("reads the optional Guest Nickname column (blank ⇒ null)", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname,Mehndi,Wedding Ceremony",
      "1,Okafor,Chidi,Okafor,Chi,yes,yes",
      "2,Testfamily,Ada,Testfamily,,yes,yes",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families[0]!.guests[0]!.nickname).toBe("Chi");
    // A blank nickname cell is treated as absent (null), not an empty string.
    expect(families[1]!.guests[0]!.nickname).toBeNull();
    // The nickname column is not mistaken for an event column.
    expect(families[0]!.guests[0]!.eventNames).not.toContain("Guest Nickname");
  });

  it("matches event columns case+whitespace-insensitively", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,  mehndi  ,WEDDING CEREMONY",
      "1,Testfamily,Ada,Testfamily,yes,yes",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect([...families[0]!.guests[0]!.eventNames].toSorted()).toEqual(
      ["Mehndi", "Wedding Ceremony"].toSorted(),
    );
  });

  it("rejects an unmatched event column", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet",
      "1,Testfamily,Ada,Testfamily,yes,yes",
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseGuestsCsv(csv, events)));
    expect(error).toBeInstanceOf(UnmatchedEventColumn);
    expect((error as UnmatchedEventColumn).column).toBe("Sangeet");
  });

  for (const marker of ["=", "+", "-", "@"]) {
    it(`rejects formula injection prefix '${marker}' in guests sheet`, async () => {
      const csv = [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
        `1,Testfamily,${marker}HACK,Testfamily,yes,yes`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseGuestsCsv(csv, events)));
      expect(error).toBeInstanceOf(FormulaInjectionDetected);
    });
  }

  it("fails when a required column is missing", async () => {
    const csv = ["Family ID,Guest First Name,Guest Last Name,Mehndi", "1,Ada,Testfamily,yes"].join(
      "\n",
    );
    const error = await Effect.runPromise(Effect.flip(parseGuestsCsv(csv, events)));
    expect(error).toBeInstanceOf(MissingRequiredColumn);
  });

  it("groups multi-row families together", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      "1,Testfamily,Ada,Testfamily,yes,yes",
      "2,Sampleton,Bo,Sampleton,no,yes",
      "1,Testfamily,Fenn,Testfamily,yes,no",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    // Three rows, two unique families, but Testfamily appears twice — the parser
    // groups by (case+whitespace-normalised) family name, so we expect 2.
    expect(families).toHaveLength(2);
    const sharma = families.find((f) => f.familyName === "Testfamily")!;
    expect(sharma.guests).toHaveLength(2);
  });

  it("handles CRLF line endings", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      "1,Testfamily,Ada,Testfamily,yes,yes",
    ].join("\r\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families).toHaveLength(1);
  });

  it("handles quoted cells with commas in family/guest names", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      `1,"Smith, Jr.",John,"O""Connor",yes,yes`,
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families[0]!.familyName).toBe("Smith, Jr.");
    expect(families[0]!.guests[0]!.lastName).toBe(`O"Connor`);
  });
});

describe("fidelity columns (E2 — honoured, not just ignored)", () => {
  const events = [
    {
      name: "Mehndi",
      startAt: "x",
      endAt: "x",
      timezone: "x",
      location: "",
      address: null,
      dressCodeDescription: null,
      dressCodePalette: [],
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 0,
    },
    {
      name: "Wedding Ceremony",
      startAt: "x",
      endAt: "x",
      timezone: "x",
      location: "",
      address: null,
      dressCodeDescription: null,
      dressCodePalette: [],
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 1,
    },
  ];

  it("honours the Event ID column into ParsedEvent.id (absent ⇒ id is undefined)", async () => {
    const withId = [
      "Event Name,Start,Timezone,Event ID",
      "Mehndi,2026-09-18T16:00:00+10:00,Australia/Sydney,evt_abc",
    ].join("\n");
    const [ev] = await Effect.runPromise(parseEventsCsv(withId));
    expect(ev!.id).toBe("evt_abc");

    const noId = [
      "Event Name,Start,Timezone",
      "Mehndi,2026-09-18T16:00:00+10:00,Australia/Sydney",
    ].join("\n");
    const [ev2] = await Effect.runPromise(parseEventsCsv(noId));
    expect(ev2!.id).toBeUndefined();
  });

  it("a blank Event ID cell leaves the event id-less (manually-added row)", async () => {
    const csv = [
      "Event Name,Start,Timezone,Event ID",
      "Mehndi,2026-09-18T16:00:00+10:00,Australia/Sydney,",
    ].join("\n");
    const [ev] = await Effect.runPromise(parseEventsCsv(csv));
    expect(ev!.id).toBeUndefined();
  });

  it("honours Guest ID + Family Code + internal Family ID at full fidelity", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Family Code,Guest ID",
      "fam_internal,Testfamily,Ada,Testfamily,yes,yes,SUNSET-4210,gst_ada",
      "fam_internal,Testfamily,Bo,Testfamily,no,yes,SUNSET-4210,gst_bo",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families).toHaveLength(1);
    expect(families[0]!.id).toBe("fam_internal");
    expect(families[0]!.publicId).toBe("SUNSET-4210");
    expect(families[0]!.guests[0]!.id).toBe("gst_ada");
    expect(families[0]!.guests[1]!.id).toBe("gst_bo");
    // Fidelity columns are NOT mistaken for event columns.
    expect(families[0]!.guests[0]!.eventNames).not.toContain("Family Code");
    expect(families[0]!.guests[0]!.eventNames).not.toContain("Guest ID");
  });

  it("does NOT honour a neutral fam-NNN Family ID absent a Family Code column (standard export)", async () => {
    // The standard export writes fam-NNN grouping keys — NOT stable ids. Without
    // the full-fidelity Family Code marker column, Family ID must stay ignored so
    // the id-less name-matched path is byte-identical to today.
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi",
      "fam-001,Testfamily,Ada,Testfamily,yes",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families[0]!.id).toBeUndefined();
    expect(families[0]!.publicId).toBeUndefined();
  });

  it("a lone Guest ID cell is still honoured even if Family Code is absent", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Guest ID",
      "1,Testfamily,Ada,Testfamily,yes,gst_ada",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families[0]!.guests[0]!.id).toBe("gst_ada");
    // But Family ID stays neutral (no Family Code column present).
    expect(families[0]!.id).toBeUndefined();
  });

  // ── Collision contract (T-S1 — must NOT change) ─────────────────────────────
  // When an event is NAMED after a reserved fidelity label, only the LAST header
  // occurrence is fidelity metadata (the exporter appends it after the event
  // columns); a SINGLE occurrence stays the event's attendance column — biased
  // against silently dropping invitations.

  it("keeps a lone 'Guest ID' column as an event attendance column when an event is so named", async () => {
    const collidingEvents = [
      { ...events[0]!, name: "Guest ID" },
      { ...events[1]!, name: "Wedding Ceremony" },
    ];
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Guest ID,Wedding Ceremony",
      "1,Testfamily,Ada,Testfamily,yes,yes",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, collidingEvents));
    // The single 'Guest ID' column is the event's attendance, NOT metadata.
    expect([...families[0]!.guests[0]!.eventNames].toSorted()).toEqual(
      ["Guest ID", "Wedding Ceremony"].toSorted(),
    );
    // …and no guest id was read from it.
    expect(families[0]!.guests[0]!.id).toBeUndefined();
  });

  it("treats only the LAST 'Guest ID' occurrence as metadata when the name also collides", async () => {
    const collidingEvents = [
      { ...events[0]!, name: "Guest ID" },
      { ...events[1]!, name: "Wedding Ceremony" },
    ];
    // First 'Guest ID' = the event attendance column; last = appended fidelity.
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Guest ID,Wedding Ceremony,Guest ID",
      "1,Testfamily,Ada,Testfamily,yes,yes,gst_ada",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, collidingEvents));
    // The attendance column (first occurrence) still counts as the invite.
    expect([...families[0]!.guests[0]!.eventNames].toSorted()).toEqual(
      ["Guest ID", "Wedding Ceremony"].toSorted(),
    );
    // The LAST occurrence supplied the guest id.
    expect(families[0]!.guests[0]!.id).toBe("gst_ada");
  });
});

describe("formula-injection trim-resilience", () => {
  it("rejects ' =SUM(A1:A2)' (leading whitespace bypass) on the events sheet", async () => {
    const csv = [
      EVENTS_HEADER,
      // Leading space is a known bypass — Excel/Sheets ignore it when
      // interpreting the cell as a formula.
      ` =SUM(A1:A2),2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,`,
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(FormulaInjectionDetected);
    const fi = error as FormulaInjectionDetected;
    // Snippet starts with `=`, not the leading whitespace.
    expect(fi.snippet.startsWith("=")).toBe(true);
  });
});

describe("CSV input caps", () => {
  const EV_HEADER = EVENTS_HEADER;

  it("rejects more than 5000 rows (MalformedSpreadsheet: too many rows)", async () => {
    const dataRows: string[] = [];
    // 5001 data rows + header = 5002 rows total, well past the cap.
    for (let i = 0; i < 5001; i += 1) {
      dataRows.push(
        `Event${i},2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,`,
      );
    }
    const csv = [EV_HEADER, ...dataRows].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(MalformedSpreadsheet);
    expect((error as MalformedSpreadsheet).reason).toBe("too many rows");
  });

  it("rejects a single cell longer than 10_000 chars (MalformedSpreadsheet: cell too large)", async () => {
    const huge = "x".repeat(10_001);
    const csv = [
      EV_HEADER,
      `Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,${huge},,,,,`,
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(MalformedSpreadsheet);
    expect((error as MalformedSpreadsheet).reason).toBe("cell too large");
  });

  it("rejects an unterminated quoted cell at EOF", async () => {
    // Open quote that never closes — historically this would silently consume
    // the rest of the file as one giant cell.
    const csv = [
      EV_HEADER,
      `"Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,`,
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
    expect(error).toBeInstanceOf(MalformedSpreadsheet);
    expect((error as MalformedSpreadsheet).reason).toBe("unterminated quoted cell");
  });
});
