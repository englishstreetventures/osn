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
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,",
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
        `Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,${value},`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
      expect(error).toBeInstanceOf(MalformedSpreadsheet);
      expect((error as MalformedSpreadsheet).reason).toBe("Pinterest URL must be an http(s) URL");
    });

    it(`rejects ${label} Maps URL`, async () => {
      const csv = [
        EVENTS_HEADER,
        `Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,${value}`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseEventsCsv(csv)));
      expect(error).toBeInstanceOf(MalformedSpreadsheet);
      expect((error as MalformedSpreadsheet).reason).toBe("Maps URL must be an http(s) URL");
    });
  }

  it("accepts http and https URLs", async () => {
    const csv = [
      EVENTS_HEADER,
      "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,http://pin.example/x,https://maps.example/q",
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
      "1,Sharma,Priya,Sharma,TRUE,yes",
      "1,Sharma,Anil,Sharma,1,x",
      "2,Wilson,James,Wilson,FALSE,TRUE",
    ].join("\n");

    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect(families).toHaveLength(2);
    expect(families[0]!.familyName).toBe("Sharma");
    expect(families[0]!.guests).toHaveLength(2);
    expect([...families[0]!.guests[0]!.eventNames].sort()).toEqual(
      ["Mehndi", "Wedding Ceremony"].sort(),
    );
    expect([...families[0]!.guests[1]!.eventNames].sort()).toEqual(
      ["Mehndi", "Wedding Ceremony"].sort(),
    );
    expect(families[1]!.guests[0]!.eventNames).toEqual(["Wedding Ceremony"]);
  });

  it("matches event columns case+whitespace-insensitively", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,  mehndi  ,WEDDING CEREMONY",
      "1,Sharma,Priya,Sharma,yes,yes",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    expect([...families[0]!.guests[0]!.eventNames].sort()).toEqual(
      ["Mehndi", "Wedding Ceremony"].sort(),
    );
  });

  it("rejects an unmatched event column", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet",
      "1,Sharma,Priya,Sharma,yes,yes",
    ].join("\n");
    const error = await Effect.runPromise(Effect.flip(parseGuestsCsv(csv, events)));
    expect(error).toBeInstanceOf(UnmatchedEventColumn);
    expect((error as UnmatchedEventColumn).column).toBe("Sangeet");
  });

  for (const marker of ["=", "+", "-", "@"]) {
    it(`rejects formula injection prefix '${marker}' in guests sheet`, async () => {
      const csv = [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
        `1,Sharma,${marker}HACK,Sharma,yes,yes`,
      ].join("\n");
      const error = await Effect.runPromise(Effect.flip(parseGuestsCsv(csv, events)));
      expect(error).toBeInstanceOf(FormulaInjectionDetected);
    });
  }

  it("fails when a required column is missing", async () => {
    const csv = ["Family ID,Guest First Name,Guest Last Name,Mehndi", "1,Priya,Sharma,yes"].join(
      "\n",
    );
    const error = await Effect.runPromise(Effect.flip(parseGuestsCsv(csv, events)));
    expect(error).toBeInstanceOf(MissingRequiredColumn);
  });

  it("groups multi-row families together", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      "1,Sharma,Priya,Sharma,yes,yes",
      "2,Wilson,James,Wilson,no,yes",
      "1,Sharma,Anil,Sharma,yes,no",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(csv, events));
    // Three rows, two unique families, but Sharma appears twice — the parser
    // groups by (case+whitespace-normalised) family name, so we expect 2.
    expect(families).toHaveLength(2);
    const sharma = families.find((f) => f.familyName === "Sharma")!;
    expect(sharma.guests).toHaveLength(2);
  });

  it("handles CRLF line endings", async () => {
    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
      "1,Sharma,Priya,Sharma,yes,yes",
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
