import { describe, expect, it } from "vitest";

import { formatImportError } from "./import-errors";

/**
 * The contract these lock down: every locating field the API sends (reason, row,
 * column, sheet) reaches the organiser, and the message says what to change.
 * The regression being guarded is the original one — a 422 rendering as the bare
 * word "Malformed spreadsheet" for fourteen different problems.
 */
describe("formatImportError — malformed spreadsheet", () => {
  it("names the sheet, the row and the column", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "Start must be an ISO-8601 timestamp",
      row: 4,
      column: 2,
      sheet: "events",
    });
    expect(msg).toContain("events sheet");
    expect(msg).toContain("row 4");
    expect(msg).toContain("column 2");
    // And an example of the shape actually wanted, not just the format's name —
    // a LOCAL time, with no offset to work out.
    expect(msg).toContain("2026-11-14T15:00");
    expect(msg).not.toContain("2026-11-14T15:00+");
  });

  it("explains a non-IANA Timezone with a Region/City example, not an offset", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "Timezone must be an IANA timezone name",
      row: 4,
      column: 4,
      sheet: "events",
    });
    expect(msg).toContain("events sheet");
    expect(msg).toContain("row 4");
    expect(msg).toContain("column 4");
    expect(msg).toContain("Australia/Sydney");
    // A raw offset is exactly what this reason exists to steer an organiser
    // away from — the message names it explicitly as one of the wrong answers.
    expect(msg).toMatch(/offset/i);
  });

  it("warns that spreadsheet apps rewrite date cells (the most likely cause)", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "Start must be an ISO-8601 timestamp",
      row: 2,
      column: 2,
      sheet: "events",
    });
    expect(msg).toMatch(/excel|numbers|sheets/i);
  });

  it("explains an unterminated quote in terms of the file, not the parser", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "unterminated quoted cell",
      row: null,
      column: null,
      sheet: "events",
    });
    expect(msg).toContain("events sheet");
    expect(msg).toMatch(/quote/i);
    expect(msg).not.toBe("Malformed spreadsheet");
  });

  it("tells the organiser a 'blank' row is only skipped when every cell is empty", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "Guest First Name is required",
      row: 9,
      column: 3,
      sheet: "guests",
    });
    expect(msg).toContain("row 9");
    expect(msg).toContain("Guest First Name");
    expect(msg).toMatch(/every single cell/i);
  });

  it("falls back to the server's reason for one this build doesn't know", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "some future rule",
      row: 3,
      sheet: "guests",
    });
    expect(msg).toContain("some future rule");
    expect(msg).toContain("row 3");
  });

  it("omits the location entirely when the API gave none", () => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "empty events sheet",
    });
    expect(msg).not.toContain("undefined");
    expect(msg).not.toContain("null");
    expect(msg).toMatch(/empty/i);
  });
});

describe("formatImportError — every reason arm resolves", () => {
  // The module claims its switch is exhaustive against the server's closed
  // `MalformedSpreadsheetReason` union. A per-reason case makes that testable —
  // and the derived-label arms (Pinterest vs Maps, Start vs End) are exactly
  // where a copy-paste slip yields a confidently wrong sentence.
  const REASONS: [string, RegExp][] = [
    ["too many rows", /5,000 rows/],
    ["cell too large", /10,000 characters/],
    ["unterminated quoted cell", /quote/i],
    ["empty events sheet", /empty/i],
    ["empty guests sheet", /empty/i],
    ["Event Name is required", /Event Name/],
    ["Start is required", /Start/],
    ["Timezone is required", /Timezone/],
    ["Start must be an ISO-8601 timestamp", /Start must look like/],
    ["End must be an ISO-8601 timestamp", /End must look like/],
    ["Pinterest URL must be an http(s) URL", /Pinterest URL/],
    ["Maps URL must be an http(s) URL", /Maps URL/],
    ["Family Name is required", /Family Name/],
    ["Guest First Name is required", /Guest First Name/],
  ];

  it.each(REASONS)("renders a specific sentence for %s", (reason, expected) => {
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason,
      row: 3,
      column: 4,
      sheet: "events",
    });
    expect(msg).toMatch(expected);
    expect(msg).not.toContain("undefined");
    expect(msg).not.toContain("null");
  });

  it("does not confuse the Maps arm with the Pinterest arm", () => {
    const maps = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "Maps URL must be an http(s) URL",
      sheet: "events",
    });
    expect(maps).toContain("Maps URL");
    expect(maps).not.toContain("Pinterest");
  });

  it("does not confuse the End arm with the Start arm", () => {
    const end = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "End must be an ISO-8601 timestamp",
      sheet: "events",
    });
    expect(end).toContain("End must look like");
    expect(end).not.toMatch(/\bStart must look like/);
  });

  it("degrades gracefully when the API sent no sheet", () => {
    const missing = formatImportError(422, { error: "Missing required column", column: "Start" });
    expect(missing).toMatch(/your sheet/i);
    expect(missing).not.toContain("undefined");

    const capacity = formatImportError(402, { error: "payment_required" });
    expect(capacity).toMatch(/guest limit/i);
    expect(capacity).not.toContain("undefined");
  });

  it("ignores a sheet value that isn't one of the two literals", () => {
    // The body is cast from res.json(), so `sheet` is unvalidated at runtime —
    // indexing a record with it would return an inherited prototype key.
    const msg = formatImportError(422, {
      error: "Malformed spreadsheet",
      reason: "empty events sheet",
      sheet: "constructor" as unknown as "events",
    });
    expect(msg).toMatch(/empty/i);
    expect(msg).not.toContain("function");
  });
});

describe("formatImportError — column problems", () => {
  it("quotes the missing column and points at the template", () => {
    const msg = formatImportError(422, {
      error: "Missing required column",
      column: "Event Name",
      sheet: "events",
    });
    expect(msg).toContain('"Event Name"');
    expect(msg).toContain("events sheet");
    expect(msg).toMatch(/template/i);
  });

  it("explains an unmatched event column and how to resolve it", () => {
    const msg = formatImportError(422, {
      error: "Unmatched event column",
      column: "Sangeet",
      sheet: "guests",
    });
    expect(msg).toContain('"Sangeet"');
    // The fix is order-of-operations: the event has to exist first.
    expect(msg).toMatch(/events sheet|Events tab/i);
  });

  it("says which characters trip the formula guard", () => {
    const msg = formatImportError(422, {
      error: "Formula-injection guard tripped",
      row: 5,
      column: 3,
      sheet: "events",
    });
    expect(msg).toContain("row 5");
    expect(msg).toContain("=");
  });
});

describe("formatImportError — non-parse failures", () => {
  it("explains a 409 as 'press Preview again'", () => {
    const msg = formatImportError(409, { error: "State changed — re-preview" });
    expect(msg).toMatch(/preview again/i);
  });

  it("gives the size limit on a 413", () => {
    const msg = formatImportError(413, { error: "Payload too large" });
    expect(msg).toMatch(/1 MB/i);
  });

  it("names the cap on a capacity 402", () => {
    const msg = formatImportError(402, { error: "payment_required", limit: 120, current: 118 });
    expect(msg).toContain("120");
  });

  it("falls back to the API error string, then the status", () => {
    expect(formatImportError(500, { error: "Storage error" })).toBe("Storage error");
    expect(formatImportError(503, {})).toBe("Request failed (503)");
  });
});
