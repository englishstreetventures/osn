import { Effect, Data } from "effect";

import { bucketParseReason, metricImportParseRejected } from "../metrics";
import type { ParsedEvent, ParsedFamily, ParsedGuest, PaletteSwatch } from "../schemas/import";

// ── Tagged errors ────────────────────────────────────────────────────────────

export class MalformedSpreadsheet extends Data.TaggedError("MalformedSpreadsheet")<{
  readonly reason: string;
  readonly row?: number;
  readonly column?: number;
}> {}

export class FormulaInjectionDetected extends Data.TaggedError("FormulaInjectionDetected")<{
  readonly row: number;
  readonly column: number;
  readonly snippet: string;
}> {}

export class MissingRequiredColumn extends Data.TaggedError("MissingRequiredColumn")<{
  readonly column: string;
}> {}

export class UnmatchedEventColumn extends Data.TaggedError("UnmatchedEventColumn")<{
  readonly column: string;
}> {}

export type SpreadsheetParseError =
  | MalformedSpreadsheet
  | FormulaInjectionDetected
  | MissingRequiredColumn
  | UnmatchedEventColumn;

// ── Hand-rolled RFC 4180 CSV parser ──────────────────────────────────────────

/** Hard caps on parsed CSV size. */
const MAX_ROWS = 5000;
const MAX_CELL_LENGTH = 10_000;

export type CsvParseResult =
  | { ok: true; rows: string[][] }
  | { ok: false; reason: string; row?: number; column?: number };

/**
 * Parse a CSV blob into a 2D array of strings. Handles quoted cells, escaped
 * quotes (`""`), multi-line cells, and CRLF/LF/CR line endings. Preserves a
 * trailing empty cell after a comma. A trailing newline does not produce an
 * extra empty row.
 *
 * Returns the raw rows; size + structural caps live in `parseCsvBounded`.
 * Existing callers can still use this for the unbounded form.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && content[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Treat CR or CRLF as a row terminator.
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += content[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }

  // Flush trailing cell unless the file ended exactly on a row terminator
  // (in which case `cell` is empty and `row` is empty).
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

const tooManyRows = (): CsvParseResult => ({ ok: false, reason: "too many rows" });
const cellTooLarge = (): CsvParseResult => ({ ok: false, reason: "cell too large" });

/**
 * Bounded CSV parser. Enforces:
 *  - total rows ≤ `MAX_ROWS`
 *  - any single cell length ≤ `MAX_CELL_LENGTH`
 *  - file does not end mid-quoted-cell (`"foo` with no closing quote)
 *
 * Returns a discriminated result instead of throwing so the Effect-shaped
 * caller can map it to a tagged error.
 */
export function parseCsvBounded(content: string): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = content.length;

  while (i < n) {
    if (cell.length > MAX_CELL_LENGTH) return cellTooLarge();
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && content[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      if (cell.length > MAX_CELL_LENGTH) return cellTooLarge();
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (cell.length > MAX_CELL_LENGTH) return cellTooLarge();
      row.push(cell);
      rows.push(row);
      if (rows.length > MAX_ROWS) return tooManyRows();
      row = [];
      cell = "";
      i += content[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      if (cell.length > MAX_CELL_LENGTH) return cellTooLarge();
      row.push(cell);
      rows.push(row);
      if (rows.length > MAX_ROWS) return tooManyRows();
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }

  // EOF — if we never closed a quote, the input is malformed.
  if (inQuotes) {
    return { ok: false, reason: "unterminated quoted cell" };
  }

  if (cell.length > MAX_CELL_LENGTH) return cellTooLarge();
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
    if (rows.length > MAX_ROWS) return tooManyRows();
  }

  return { ok: true, rows };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const FORMULA_MARKERS = new Set(["=", "+", "-", "@"]);

/**
 * Normalise a header / event-name for case+whitespace-insensitive matching.
 */
function normaliseName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function detectFormulaInjection(
  rows: string[][],
  headerRowIndex: number,
): FormulaInjectionDetected | null {
  for (let r = headerRowIndex; r < rows.length; r += 1) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c]!;
      // Trim FIRST — leading whitespace is a known bypass (Excel/Sheets ignore
      // surrounding whitespace when interpreting formulas, so " =SUM(...)" is
      // still dangerous).
      const trimmed = cell.trim();
      if (trimmed.length === 0) continue;
      const first = trimmed[0]!;
      if (FORMULA_MARKERS.has(first)) {
        return new FormulaInjectionDetected({
          row: r + 1, // 1-indexed for human-readable coords
          column: c + 1,
          snippet: trimmed.slice(0, 10),
        });
      }
    }
  }
  return null;
}

function parseDressCodePalette(raw: string): PaletteSwatch[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const out: PaletteSwatch[] = [];
  for (const pair of trimmed.split("|")) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const name = pair.slice(0, colonIdx).trim();
    const color = pair.slice(colonIdx + 1).trim();
    if (name.length === 0 || color.length === 0) continue;
    out.push({ name, color });
  }
  return out;
}

const TRUTHY = new Set(["true", "yes", "1", "x"]);

function isTruthy(s: string): boolean {
  return TRUTHY.has(s.trim().toLowerCase());
}

function nullableString(s: string): string | null {
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a URL cell into a trimmed http(s) string, or null when blank.
 * Returns `undefined` for present-but-non-http(s) values so the caller
 * can emit a {@link MalformedSpreadsheet} with row/column context — a
 * `javascript:` href would otherwise reach the organiser UI and XSS.
 */
function parseHttpUrl(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// ── Parsers ──────────────────────────────────────────────────────────────────

const REQUIRED_EVENT_COLUMNS = ["Event Name", "Start", "End", "Timezone"] as const;

export function parseEventsCsv(
  content: string,
): Effect.Effect<ParsedEvent[], SpreadsheetParseError> {
  return Effect.gen(function* () {
    const result = parseCsvBounded(content);
    if (!result.ok) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: result.reason }));
    }
    const rows = result.rows;
    if (rows.length === 0) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: "empty events sheet" }));
    }

    const formula = detectFormulaInjection(rows, 0);
    if (formula) return yield* Effect.fail(formula);

    const header = rows[0]!.map((h) => h.trim());
    const headerNorm = header.map(normaliseName);
    const indexOf = (label: string) => headerNorm.indexOf(normaliseName(label));

    for (const required of REQUIRED_EVENT_COLUMNS) {
      if (indexOf(required) === -1) {
        return yield* Effect.fail(new MissingRequiredColumn({ column: required }));
      }
    }

    const idxName = indexOf("Event Name");
    const idxStart = indexOf("Start");
    const idxEnd = indexOf("End");
    const idxTz = indexOf("Timezone");
    const idxLocation = indexOf("Location");
    const idxAddress = indexOf("Address");
    const idxDressDesc = indexOf("Dress Code Description");
    const idxPalette = indexOf("Dress Code Palette");
    const idxPinterest = indexOf("Pinterest URL");
    const idxMaps = indexOf("Maps URL");

    const out: ParsedEvent[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r]!;
      // Skip wholly empty rows (e.g. trailing blank line copy/pasted from sheets).
      if (row.every((cell) => cell.trim().length === 0)) continue;

      const name = (row[idxName] ?? "").trim();
      const startAt = (row[idxStart] ?? "").trim();
      const endAt = (row[idxEnd] ?? "").trim();
      const timezone = (row[idxTz] ?? "").trim();

      if (name.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Event Name is required",
            row: r + 1,
            column: idxName + 1,
          }),
        );
      }
      if (startAt.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Start is required",
            row: r + 1,
            column: idxStart + 1,
          }),
        );
      }
      if (endAt.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "End is required",
            row: r + 1,
            column: idxEnd + 1,
          }),
        );
      }
      if (timezone.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Timezone is required",
            row: r + 1,
            column: idxTz + 1,
          }),
        );
      }

      const pinterestUrl = idxPinterest === -1 ? null : parseHttpUrl(row[idxPinterest] ?? "");
      if (pinterestUrl === undefined) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Pinterest URL must be an http(s) URL",
            row: r + 1,
            column: idxPinterest + 1,
          }),
        );
      }
      const mapsUrl = idxMaps === -1 ? null : parseHttpUrl(row[idxMaps] ?? "");
      if (mapsUrl === undefined) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Maps URL must be an http(s) URL",
            row: r + 1,
            column: idxMaps + 1,
          }),
        );
      }

      out.push({
        name,
        startAt,
        endAt,
        timezone,
        location: idxLocation === -1 ? "" : (row[idxLocation] ?? "").trim(),
        address: idxAddress === -1 ? null : nullableString(row[idxAddress] ?? ""),
        dressCodeDescription: idxDressDesc === -1 ? null : nullableString(row[idxDressDesc] ?? ""),
        dressCodePalette: idxPalette === -1 ? [] : parseDressCodePalette(row[idxPalette] ?? ""),
        pinterestUrl,
        mapsUrl,
        sortOrder: out.length,
      });
    }

    return out;
  }).pipe(
    Effect.tapError((e) => Effect.sync(() => metricImportParseRejected(bucketParseReason(e._tag)))),
    Effect.withSpan("cire.import.parseEvents"),
  );
}

const REQUIRED_GUEST_COLUMNS = [
  "Family ID",
  "Family Name",
  "Guest First Name",
  "Guest Last Name",
] as const;

export function parseGuestsCsv(
  content: string,
  events: readonly ParsedEvent[],
): Effect.Effect<ParsedFamily[], SpreadsheetParseError> {
  return Effect.gen(function* () {
    const result = parseCsvBounded(content);
    if (!result.ok) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: result.reason }));
    }
    const rows = result.rows;
    if (rows.length === 0) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: "empty guests sheet" }));
    }

    const formula = detectFormulaInjection(rows, 0);
    if (formula) return yield* Effect.fail(formula);

    const header = rows[0]!.map((h) => h.trim());
    const headerNorm = header.map(normaliseName);
    const indexOf = (label: string) => headerNorm.indexOf(normaliseName(label));

    for (const required of REQUIRED_GUEST_COLUMNS) {
      if (indexOf(required) === -1) {
        return yield* Effect.fail(new MissingRequiredColumn({ column: required }));
      }
    }

    const idxFamilyName = indexOf("Family Name");
    const idxFirst = indexOf("Guest First Name");
    const idxLast = indexOf("Guest Last Name");
    const fixedCols = new Set([indexOf("Family ID"), idxFamilyName, idxFirst, idxLast]);

    // Map event-column index → canonical event name. Strict match — any
    // unmatched event column surfaces as `UnmatchedEventColumn`.
    const eventByNorm = new Map(events.map((e) => [normaliseName(e.name), e.name]));
    const eventColumns: { idx: number; eventName: string }[] = [];
    for (let c = 0; c < header.length; c += 1) {
      if (fixedCols.has(c)) continue;
      const colHeader = header[c]!;
      if (colHeader.length === 0) continue;
      const matched = eventByNorm.get(normaliseName(colHeader));
      if (!matched) {
        return yield* Effect.fail(new UnmatchedEventColumn({ column: colHeader }));
      }
      eventColumns.push({ idx: c, eventName: matched });
    }

    // Group sequential rows by (case+whitespace-normalised) family name. The
    // first row's spelling wins; subsequent rows just append guests.
    const families: ParsedFamily[] = [];
    const familyByNorm = new Map<string, ParsedFamily>();

    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r]!;
      const familyName = (row[idxFamilyName] ?? "").trim();
      const firstName = (row[idxFirst] ?? "").trim();
      const lastName = (row[idxLast] ?? "").trim();

      // Skip wholly-blank rows.
      if (familyName.length === 0 && firstName.length === 0 && lastName.length === 0) continue;

      if (familyName.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Family Name is required",
            row: r + 1,
            column: idxFamilyName + 1,
          }),
        );
      }
      if (firstName.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Guest First Name is required",
            row: r + 1,
            column: idxFirst + 1,
          }),
        );
      }

      const eventNames: string[] = [];
      for (const { idx, eventName } of eventColumns) {
        const cell = row[idx] ?? "";
        if (isTruthy(cell)) eventNames.push(eventName);
      }

      const guest: ParsedGuest = { firstName, lastName, eventNames };
      const norm = normaliseName(familyName);
      let family = familyByNorm.get(norm);
      if (!family) {
        family = { familyName, guests: [guest] };
        familyByNorm.set(norm, family);
        families.push(family);
      } else {
        // Mutate in place — the array reference is the same one in `families`.
        (family.guests as ParsedGuest[]).push(guest);
      }
    }

    return families;
  }).pipe(
    Effect.tapError((e) => Effect.sync(() => metricImportParseRejected(bucketParseReason(e._tag)))),
    Effect.withSpan("cire.import.parseGuests"),
  );
}
