import { Effect, Data } from "effect";

import {
  EVENT_SHEET_REQUIRED_HEADERS,
  FAMILY_CODE_HEADER,
  GUEST_ID_HEADER,
  GUEST_NICKNAME_HEADER,
  GUEST_SHEET_FIXED_HEADERS,
} from "../lib/sheet-headers";
import { bucketParseReason, metricImportParseRejected } from "../metrics";
import type { ParsedEvent, ParsedFamily, ParsedGuest, PaletteSwatch } from "../schemas/import";

// ── Tagged errors ────────────────────────────────────────────────────────────

/**
 * The closed set of `MalformedSpreadsheet.reason` values.
 *
 * SECURITY (reason lockdown): `reason` is surfaced to the organiser in the 422
 * body, so it MUST only ever carry STATIC string literals — NEVER interpolated
 * cell contents. Reflecting attacker-controlled spreadsheet data here would let
 * a hostile uploaded sheet inject arbitrary text into the API response. The
 * `row`/`column` NUMBERS are safe to surface (and are); the cell CONTENTS are
 * not. Keeping `reason` a closed union (not `string`) makes it a compile error
 * for a future contributor to pass an interpolated/dynamic string — the type is
 * the enforcement mechanism, so do NOT widen it back to `string`.
 */
export type MalformedSpreadsheetReason =
  // Structural / size caps (from `parseCsvBounded`).
  | "too many rows"
  | "cell too large"
  | "unterminated quoted cell"
  // Empty-sheet guards.
  | "empty events sheet"
  | "empty guests sheet"
  // Required per-row event fields.
  | "Event Name is required"
  | "Start is required"
  | "Timezone is required"
  // Timestamp-shape rejections (see isIsoTimestamp).
  | "Start must be an ISO-8601 timestamp"
  | "End must be an ISO-8601 timestamp"
  // URL-cell scheme rejections.
  | "Pinterest URL must be an http(s) URL"
  | "Maps URL must be an http(s) URL"
  // Required per-row guest fields.
  | "Family Name is required"
  | "Guest First Name is required";

export class MalformedSpreadsheet extends Data.TaggedError("MalformedSpreadsheet")<{
  /** STATIC literal only — never interpolated cell contents. See {@link MalformedSpreadsheetReason}. */
  readonly reason: MalformedSpreadsheetReason;
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
  // `reason` is one of the structural literals — flows straight into a
  // `MalformedSpreadsheet`, so it shares the closed-union constraint.
  | {
      ok: false;
      reason: Extract<
        MalformedSpreadsheetReason,
        "too many rows" | "cell too large" | "unterminated quoted cell"
      >;
      row?: number;
      column?: number;
    };

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
 * Validate a Start/End cell as an ISO-8601 timestamp: a zero-padded
 * `YYYY-MM-DDTHH:MM` prefix AND parseable by `Date`. The prefix check is
 * load-bearing beyond display: `events.start_at`/`end_at` are compared
 * LEXICALLY against a `YYYY-MM-DD` cutoff by the guest-data retention sweep
 * (`services/retention.ts`), so a free-text date like "1st Nov 2026" (sorts
 * below any `2…` cutoff) would make an upcoming wedding aggregate as expired
 * and have its guest PII deleted, while "TBD" (sorts above) would never
 * expire. Enforcing the shape at the sole ingest point makes the sweep's
 * documented invariant actually true.
 */
function isIsoTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(new Date(s).getTime());
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

// Only Event Name / Start / Timezone are hard requirements — the minimum to
// render and order an event on the invite. `End` is optional (column and cell):
// an open-ended event stores `endAt: ""` (the DB column is NOT NULL with the ""
// sentinel meaning "no stated end"; display + calendar + retention all handle
// it). `Location` is optional too — the invite's "Where" + Open-in-Maps derive
// from `Address` (see `cire/web/src/components/event-details.ts`), and a
// provided Location is only used as the address fallback at import-write time
// when Address is blank (see `services/import.ts`).
const REQUIRED_EVENT_COLUMNS = EVENT_SHEET_REQUIRED_HEADERS;

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
      // Optional: "" = no stated end (column may be absent entirely).
      const endAt = idxEnd === -1 ? "" : (row[idxEnd] ?? "").trim();
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
      if (timezone.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Timezone is required",
            row: r + 1,
            column: idxTz + 1,
          }),
        );
      }
      if (!isIsoTimestamp(startAt)) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Start must be an ISO-8601 timestamp",
            row: r + 1,
            column: idxStart + 1,
          }),
        );
      }
      if (endAt.length > 0 && !isIsoTimestamp(endAt)) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "End must be an ISO-8601 timestamp",
            row: r + 1,
            column: idxEnd + 1,
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
        location: idxLocation === -1 ? null : nullableString(row[idxLocation] ?? ""),
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

const REQUIRED_GUEST_COLUMNS = GUEST_SHEET_FIXED_HEADERS;

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
    // Optional: an informal name for the single-guest greeting. Absent ⇒ -1.
    const idxNickname = indexOf(GUEST_NICKNAME_HEADER);
    // Fixed (non-event) columns. Absent lookups are -1, which
    // `fixedCols.has(c)` (c ≥ 0) never matches.
    const fixedCols = new Set([
      indexOf("Family ID"),
      idxFamilyName,
      idxFirst,
      idxLast,
      idxNickname,
    ]);

    // Map event-column index → canonical event name. Strict match — any
    // unmatched event column surfaces as `UnmatchedEventColumn`.
    const eventByNorm = new Map(events.map((e) => [normaliseName(e.name), e.name]));

    // Full-fidelity export/snapshot columns (Guest ID / Family Code) are
    // accepted-and-IGNORED here (the E2 ID-aware diff starts honouring them).
    // An event may legitimately share one of these labels, making its
    // attendance column ambiguous — resolve deterministically, biased against
    // silently dropping invitations: when the label is ALSO a known event
    // name, only the LAST occurrence is fidelity metadata (the exporter
    // appends fidelity columns after the event columns), and a single
    // occurrence stays the event's attendance column. A label that matches no
    // event is fidelity metadata at every occurrence.
    const fidelityCols = new Set<number>();
    for (const label of [GUEST_ID_HEADER, FAMILY_CODE_HEADER]) {
      const norm = normaliseName(label);
      const indices: number[] = [];
      headerNorm.forEach((h, i) => {
        if (h === norm) indices.push(i);
      });
      if (indices.length === 0) continue;
      if (eventByNorm.has(norm)) {
        if (indices.length >= 2) fidelityCols.add(indices[indices.length - 1]!);
      } else {
        for (const i of indices) fidelityCols.add(i);
      }
    }

    const eventColumns: { idx: number; eventName: string }[] = [];
    for (let c = 0; c < header.length; c += 1) {
      if (fixedCols.has(c) || fidelityCols.has(c)) continue;
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

      const nickname = idxNickname === -1 ? null : nullableString(row[idxNickname] ?? "");
      const guest: ParsedGuest = { firstName, lastName, nickname, eventNames };
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
