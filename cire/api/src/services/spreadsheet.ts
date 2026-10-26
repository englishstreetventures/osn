import { parseGuestEmail } from "@cire/guest-email";
import { Effect, Data, Option, Schema, type Types } from "effect";

import { unguardCsvCell } from "../lib/csv";
import { isKnownTimeZone, parseWallTime, stampEventOffset } from "../lib/event-time";
import {
  EVENT_ID_HEADER,
  EVENT_SHEET_REQUIRED_HEADERS,
  FAMILY_CODE_HEADER,
  FAMILY_SOURCE_HEADER,
  GUEST_ID_HEADER,
  GUEST_EMAIL_HEADER,
  GUEST_EMAIL_RECORD_HEADER,
  GUEST_NICKNAME_HEADER,
  GUEST_SHEET_FIXED_HEADERS,
  GUEST_SOURCE_HEADER,
} from "../lib/sheet-headers";
import { bucketParseReason, metricImportParseRejected } from "../metrics";
import {
  EmailRecord,
  MAX_CELL_LENGTH,
  MAX_EVENTS,
  MAX_ROWS,
  MAX_RUN_OF_SHOW_ITEMS,
} from "../schemas/import";
import type {
  DesiredFamily,
  DesiredGuest,
  ParsedEvent,
  Provenance,
  RunOfShowItem,
} from "../schemas/import";
import {
  CHILDREN_POLICY_LABEL,
  isFormulaCell,
  isTruthy,
  normaliseName,
  nullableString,
  parseDressCodePalette,
  parseHttpUrl,
  parseRunOfShowLine,
  startsWithTwelveHourTime,
  PLUS_ONE_POLICY_LABEL,
  presetFromCell,
} from "./guest-event-validation";

// ── Tagged errors ────────────────────────────────────────────────────────────

/**
 * The closed set of `MalformedSpreadsheet.reason` values.
 *
 * SECURITY (reason lockdown): `reason` is surfaced to the organiser in the 422
 * body, so it MUST only ever carry STATIC string literals — NEVER interpolated
 * cell contents. Reflecting attacker-controlled spreadsheet data here would let
 * a hostile uploaded sheet inject arbitrary text into the API response. The
 * `atRow`/`atColumn` NUMBERS are safe to surface (and are); the cell CONTENTS are
 * not. Keeping `reason` a closed union (not `string`) makes it a compile error
 * for a future contributor to pass an interpolated/dynamic string — the type is
 * the enforcement mechanism, so do NOT widen it back to `string`.
 */
export type MalformedSpreadsheetReason =
  // Structural / size caps (from `parseCsvBounded`).
  | "too many rows"
  // More events than a schedule may hold (`MAX_EVENTS`).
  | "too many events"
  | "cell too large"
  | "unterminated quoted cell"
  // Empty-sheet guards.
  | "empty events sheet"
  | "empty guests sheet"
  // Required per-row event fields.
  | "Event Name is required"
  | "Start is required"
  | "Timezone is required"
  // Timestamp-shape rejections (see parseWallTime).
  | "Start must be an ISO-8601 timestamp"
  | "End must be an ISO-8601 timestamp"
  // Zone rejection — the Timezone column is what turns a wall clock into an
  // instant, so it has to name a zone this runtime can actually resolve.
  | "Timezone must be an IANA timezone name"
  // URL-cell scheme rejections.
  | "Pinterest URL must be an http(s) URL"
  | "Maps URL must be an http(s) URL"
  // Run of Show cell rules (`parseRunOfShowLine`, `startsWithTwelveHourTime`)
  // and its item cap.
  | "Run of Show lines must start with a 24-hour time (HH:MM)"
  | "Run of Show times are 24-hour (16:00, not 4:00 pm)"
  | "Run of Show lines need a label after the time"
  | "Run of Show labels must be at most 200 characters"
  | "Run of Show holds at most 40 items"
  // Guest-policy preset cells (`presetFromCell`).
  | "Children must be Adults only, Children welcome or blank"
  | "Plus-Ones must be By invitation, Welcome or blank"
  // Required per-row guest fields.
  | "Family Name is required"
  | "Guest First Name is required"
  // An optional guest cell that holds something other than one address.
  | "Guest Email is not a valid email address";

/**
 * Which uploaded sheet a parse error came from. Stamped by the parser itself
 * (each one knows which it is) and surfaced in the 422 body, because "Malformed
 * spreadsheet" with two files in flight doesn't tell an organiser which file to
 * go and fix. Like the coordinates this is structural metadata, not cell content,
 * so it's safe to reflect.
 */
export type SheetKind = "events" | "guests";

export class MalformedSpreadsheet extends Data.TaggedError("MalformedSpreadsheet")<{
  /** STATIC literal only — never interpolated cell contents. See {@link MalformedSpreadsheetReason}. */
  readonly reason: MalformedSpreadsheetReason;
  /**
   * 1-indexed coordinates, ABSENT for a whole-file failure.
   *
   * Named `atRow`/`atColumn`, not `row`/`column`, because these are OPTIONAL on
   * an `Error` subclass. JavaScriptCore stamps its own `line`/`column`/
   * `sourceURL`/`originalLine`/`originalColumn` onto every `Error` instance, so a
   * plain `column?: number` that a construction site leaves unset does NOT read
   * back as `undefined` — it reads back as the THROW SITE's source column, and
   * `e.column ?? null` happily reflects it into the API body. (Verified: an
   * empty-sheet 422 returned `column: 37`.) V8/workerd has no such own property,
   * so production never saw it — but the tests run on Bun, and an organiser-facing
   * "column 37" for a whole-file failure is a defect on any runtime. Renaming out
   * of the collision removes the class rather than patching the one field.
   * `FormulaInjectionDetected` keeps `row`/`column`: they are REQUIRED there, so
   * the constructor always overwrites whatever the runtime stamped.
   */
  readonly atRow?: number;
  readonly atColumn?: number;
  readonly sheet?: SheetKind;
}> {}

export class FormulaInjectionDetected extends Data.TaggedError("FormulaInjectionDetected")<{
  readonly row: number;
  readonly column: number;
  readonly snippet: string;
  readonly sheet?: SheetKind;
}> {}

export class MissingRequiredColumn extends Data.TaggedError("MissingRequiredColumn")<{
  readonly column: string;
  readonly sheet?: SheetKind;
}> {}

export class UnmatchedEventColumn extends Data.TaggedError("UnmatchedEventColumn")<{
  readonly column: string;
  readonly sheet?: SheetKind;
}> {}

export type SpreadsheetParseError =
  | MalformedSpreadsheet
  | FormulaInjectionDetected
  | MissingRequiredColumn
  | UnmatchedEventColumn;

/**
 * Stamp `sheet` onto whichever parse error came out, applied once per parser via
 * `Effect.mapError` so no individual construction site has to remember it.
 * Fields are copied explicitly rather than spread — a `Data.TaggedError` is an
 * `Error` subclass, so spreading would drag `stack`/`message` into the
 * constructor args alongside the real fields.
 */
function withSheet(sheet: SheetKind) {
  return (e: SpreadsheetParseError): SpreadsheetParseError => {
    switch (e._tag) {
      case "MalformedSpreadsheet":
        return new MalformedSpreadsheet({
          reason: e.reason,
          atRow: e.atRow,
          atColumn: e.atColumn,
          sheet,
        });
      case "FormulaInjectionDetected":
        return new FormulaInjectionDetected({
          row: e.row,
          column: e.column,
          snippet: e.snippet,
          sheet,
        });
      case "MissingRequiredColumn":
        return new MissingRequiredColumn({ column: e.column, sheet });
      case "UnmatchedEventColumn":
        return new UnmatchedEventColumn({ column: e.column, sheet });
    }
  };
}

// ── Hand-rolled RFC 4180 CSV parser ──────────────────────────────────────────

/**
 * Strip a leading UTF-8 byte-order mark.
 *
 * Excel, Numbers and Google Sheets all write CSVs with a `U+FEFF` BOM. Left in,
 * it becomes part of the FIRST header cell — `"\uFEFFEvent Name"` — which then
 * matches nothing, and the organiser gets "Missing required column: Event Name"
 * while staring at a sheet whose first column is plainly headed `Event Name`.
 * The character is invisible in every editor they'd check with, so the error is
 * unfalsifiable from their side. Drop it at the door instead.
 */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfe_ff ? content.slice(1) : content;
}

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
  const text = stripBom(content);
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
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
      i += text[i + 1] === "\n" ? 2 : 1;
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
 * The longest a cell may be as uploaded: twice {@link MAX_CELL_LENGTH}. A
 * download's formula guard puts at most one `'` before each character of a
 * value, so a value at the cap can come back up to twice as long; the cap
 * itself is checked once the guard is off ({@link withinCellCap}).
 */
const MAX_RAW_CELL_LENGTH = 2 * MAX_CELL_LENGTH;

/**
 * Bounded CSV parser. Enforces:
 *  - total rows ≤ `MAX_ROWS`
 *  - any single cell length ≤ `MAX_RAW_CELL_LENGTH`
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
  const text = stripBom(content);
  const n = text.length;

  while (i < n) {
    if (cell.length > MAX_RAW_CELL_LENGTH) return cellTooLarge();
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
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
      if (cell.length > MAX_RAW_CELL_LENGTH) return cellTooLarge();
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (cell.length > MAX_RAW_CELL_LENGTH) return cellTooLarge();
      row.push(cell);
      rows.push(row);
      if (rows.length > MAX_ROWS) return tooManyRows();
      row = [];
      cell = "";
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      if (cell.length > MAX_RAW_CELL_LENGTH) return cellTooLarge();
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

  if (cell.length > MAX_RAW_CELL_LENGTH) return cellTooLarge();
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
    if (rows.length > MAX_ROWS) return tooManyRows();
  }

  return { ok: true, rows };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// The pure cell-value + name-matching rules live in `guest-event-validation.ts`
// so the DesiredState front door shares them verbatim (parser-parity invariant);
// this file keeps only the CSV-framing concerns (row/column coords, injection
// scan over a 2D grid).

function detectFormulaInjection(
  rows: string[][],
  headerRowIndex: number,
): FormulaInjectionDetected | null {
  for (let r = headerRowIndex; r < rows.length; r += 1) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c]!;
      if (isFormulaCell(cell)) {
        return new FormulaInjectionDetected({
          row: r + 1, // 1-indexed for human-readable coords
          column: c + 1,
          snippet: cell.trim().slice(0, 10),
        });
      }
    }
  }
  return null;
}

/**
 * An upload's cells with the download's formula guard taken back off
 * (`unguardCsvCell`), header row included: a download guards header cells too,
 * so an event named `+1 Drinks` heads its attendance column as `'+1 Drinks`.
 * Runs after {@link detectFormulaInjection}, which reads the cells as uploaded,
 * so a cell starting with a bare marker is still refused while a value a
 * download wrote comes back as it was stored.
 */
const unguardRows = (rows: readonly string[][]): string[][] =>
  rows.map((row) => row.map(unguardCsvCell));

/**
 * Whether every cell of an upload, its guard taken off, is within
 * {@link MAX_CELL_LENGTH}: the cap is on the value the app would store, so a
 * download of a value at the cap re-imports.
 */
const withinCellCap = (rows: readonly string[][]): boolean =>
  rows.every((row) => row.every((cell) => cell.length <= MAX_CELL_LENGTH));

// ── Parsers ──────────────────────────────────────────────────────────────────

// Only Event Name / Start / Timezone are hard requirements — the minimum to
// render and order an event on the invite. `End` is optional (column and cell):
// an open-ended event stores `endAt: ""` (the DB column is NOT NULL with the ""
// sentinel meaning "no stated end"; display + calendar + retention all handle
// it). `Location` (the venue's name) and `Description` are optional too, and a
// sheet without one of those columns says nothing about it — see
// {@link sheetText}.
const REQUIRED_EVENT_COLUMNS = EVENT_SHEET_REQUIRED_HEADERS;

/**
 * The event's description and venue name as a sheet states them. A column
 * the sheet does not carry leaves its field OUT, so the apply keeps what is
 * stored: an organiser's own sheet that never had the column must not wipe a
 * value the editor set. A column that is there is the whole truth, blank cells
 * included: a blank Description is `""` and a blank Location is `null`, which
 * clear on purpose. Both readers, the upload's and the before-image's, use it.
 */
function sheetText(
  row: readonly string[],
  idxDescription: number,
  idxVenueName: number,
): Pick<ParsedEvent, "description" | "venueName"> {
  const out: Types.Mutable<Pick<ParsedEvent, "description" | "venueName">> = {};
  if (idxDescription !== -1) out.description = nullableString(row[idxDescription] ?? "") ?? "";
  if (idxVenueName !== -1) out.venueName = nullableString(row[idxVenueName] ?? "");
  return out;
}

/** Where an events sheet keeps the run of show, getting-there and policy cells; -1 when absent. */
interface DetailColumns {
  readonly runOfShow: number;
  readonly gettingThere: number;
  readonly children: number;
  readonly plusOnes: number;
  readonly policyNote: number;
}

type SheetDetails = Pick<
  ParsedEvent,
  "runOfShow" | "gettingThere" | "childrenPolicy" | "plusOnePolicy" | "guestPolicyNote"
>;

/** A cell {@link sheetDetails} refuses, with its 0-based column. */
interface DetailRefusal {
  readonly reason: MalformedSpreadsheetReason;
  readonly column: number;
}

const RUN_OF_SHOW_REASON = {
  time: "Run of Show lines must start with a 24-hour time (HH:MM)",
  label: "Run of Show lines need a label after the time",
  long: "Run of Show labels must be at most 200 characters",
} as const satisfies Record<string, MalformedSpreadsheetReason>;

/**
 * The run of show, getting-there notes and guest policy as a sheet states them,
 * by {@link sheetText}'s rule: a column the sheet does not carry leaves its
 * field out, and one it does is the whole truth, blank cells included. A blank
 * Run of Show cell is `[]`, a blank Getting There or Guest Policy Note `null`,
 * and a blank or "Not stated" preset `null`. Each line of a Run of Show cell is
 * one item, the time first (`parseRunOfShowLine`); blank lines are skipped. A
 * line that starts with a 12-hour time is refused rather than read 12 hours out.
 *
 * An upload is refused at the first cell that breaks a rule. A before-image
 * (`snapshot`) is the app's own output and must stay revertable, so there a
 * line that is not an item is dropped, a stored label that starts with "pm" is
 * read as a label, and an unknown preset reads as not stated, as a non-http URL
 * reads blank.
 */
function sheetDetails(
  row: readonly string[],
  cols: DetailColumns,
  snapshot: boolean,
): { readonly ok: true; readonly value: SheetDetails } | ({ readonly ok: false } & DetailRefusal) {
  const out: Types.Mutable<SheetDetails> = {};
  if (cols.runOfShow !== -1) {
    const items: RunOfShowItem[] = [];
    for (const line of (row[cols.runOfShow] ?? "").split(/\r\n|\r|\n/)) {
      if (line.trim().length === 0) continue;
      if (!snapshot && startsWithTwelveHourTime(line)) {
        return {
          ok: false,
          reason: "Run of Show times are 24-hour (16:00, not 4:00 pm)",
          column: cols.runOfShow,
        };
      }
      const parsed = parseRunOfShowLine(line);
      if (parsed.ok) items.push(parsed.item);
      else if (!snapshot) {
        return { ok: false, reason: RUN_OF_SHOW_REASON[parsed.problem], column: cols.runOfShow };
      }
    }
    if (!snapshot && items.length > MAX_RUN_OF_SHOW_ITEMS) {
      return { ok: false, reason: "Run of Show holds at most 40 items", column: cols.runOfShow };
    }
    out.runOfShow = items;
  }
  if (cols.gettingThere !== -1) out.gettingThere = nullableString(row[cols.gettingThere] ?? "");
  if (cols.policyNote !== -1) out.guestPolicyNote = nullableString(row[cols.policyNote] ?? "");
  if (cols.children !== -1) {
    const preset = presetFromCell(row[cols.children] ?? "", CHILDREN_POLICY_LABEL);
    if (preset === undefined && !snapshot) {
      return {
        ok: false,
        reason: "Children must be Adults only, Children welcome or blank",
        column: cols.children,
      };
    }
    out.childrenPolicy = preset ?? null;
  }
  if (cols.plusOnes !== -1) {
    const preset = presetFromCell(row[cols.plusOnes] ?? "", PLUS_ONE_POLICY_LABEL);
    if (preset === undefined && !snapshot) {
      return {
        ok: false,
        reason: "Plus-Ones must be By invitation, Welcome or blank",
        column: cols.plusOnes,
      };
    }
    out.plusOnePolicy = preset ?? null;
  }
  return { ok: true, value: out };
}

/** A stored Start/End that carries its own UTC offset (or `Z`). */
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

export interface ParseEventsOptions {
  /**
   * The sheet is a checkpoint before-image (`stateExportService.eventsCsv(_,
   * "snapshot")`) that a revert is reading back — never an upload. Only
   * `services/revert.ts` passes it.
   *
   * A snapshot is the app's own output, and the events editor stores values an
   * upload may not carry, so the reader restores what was stored:
   *  - no row or cell cap and no formula scan (the snapshot is written without
   *    the `'` guard);
   *  - Start, End and Timezone are taken as stored. A zone that resolves
   *    re-stamps the offset as an upload does; one that does not keeps the
   *    stored value, offset and all. A zone that does not resolve on a value
   *    with no offset (a before-image written before snapshots kept offsets)
   *    is still refused, since there is no instant to restore;
   *  - a URL that is not http(s) reads as blank.
   *
   * Event Name stays required, and `MAX_EVENTS` still applies.
   */
  readonly snapshot?: boolean;
}

export function parseEventsCsv(
  content: string,
  options: ParseEventsOptions = {},
): Effect.Effect<ParsedEvent[], SpreadsheetParseError> {
  const snapshot = options.snapshot === true;
  return Effect.gen(function* () {
    const result: CsvParseResult = snapshot
      ? { ok: true, rows: parseCsv(content) }
      : parseCsvBounded(content);
    if (!result.ok) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: result.reason }));
    }
    if (result.rows.length === 0) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: "empty events sheet" }));
    }

    if (!snapshot) {
      const formula = detectFormulaInjection(result.rows, 0);
      if (formula) return yield* Effect.fail(formula);
    }
    // A before-image is written without the guard, so it is read as written.
    const rows = snapshot ? result.rows : unguardRows(result.rows);
    if (!snapshot && !withinCellCap(rows)) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: "cell too large" }));
    }

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
    const idxVenueName = indexOf("Location");
    const idxAddress = indexOf("Address");
    const idxDescription = indexOf("Description");
    const idxDressDesc = indexOf("Dress Code Description");
    const idxPalette = indexOf("Dress Code Palette");
    const idxPinterest = indexOf("Pinterest URL");
    const idxMaps = indexOf("Maps URL");
    // Optional fidelity column (appended by `?fidelity=full` + the E3 snapshot
    // writer). Absent ⇒ -1 ⇒ id-less events ⇒ the diff matches by name exactly
    // as today. Present ⇒ each event carries its stable id, so the ID-aware diff
    // treats a rename as an update rather than remove+create.
    const idxEventId = indexOf(EVENT_ID_HEADER);
    const detailColumns: DetailColumns = {
      runOfShow: indexOf("Run of Show"),
      gettingThere: indexOf("Getting There"),
      children: indexOf("Children"),
      plusOnes: indexOf("Plus-Ones"),
      policyNote: indexOf("Guest Policy Note"),
    };

    const out: ParsedEvent[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r]!;
      // Skip wholly empty rows (e.g. trailing blank line copy/pasted from sheets).
      if (row.every((cell) => cell.trim().length === 0)) continue;

      if (out.length === MAX_EVENTS) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({ reason: "too many events", atRow: r + 1 }),
        );
      }

      const name = (row[idxName] ?? "").trim();
      const startAt = (row[idxStart] ?? "").trim();
      // Optional: "" = no stated end (column may be absent entirely).
      const endAt = idxEnd === -1 ? "" : (row[idxEnd] ?? "").trim();
      const timezone = (row[idxTz] ?? "").trim();

      if (name.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Event Name is required",
            atRow: r + 1,
            atColumn: idxName + 1,
          }),
        );
      }
      const details = sheetDetails(row, detailColumns, snapshot);
      if (!details.ok) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: details.reason,
            atRow: r + 1,
            atColumn: details.column + 1,
          }),
        );
      }
      if (snapshot) {
        const zoneKnown = isKnownTimeZone(timezone);
        if (!zoneKnown && ![startAt, endAt].every((v) => v === "" || HAS_OFFSET_RE.test(v))) {
          return yield* Effect.fail(
            new MalformedSpreadsheet({
              reason: "Timezone must be an IANA timezone name",
              atRow: r + 1,
              atColumn: idxTz + 1,
            }),
          );
        }
        const id =
          idxEventId === -1 ? undefined : (nullableString(row[idxEventId] ?? "") ?? undefined);
        const event: Types.Mutable<ParsedEvent> = {
          name,
          startAt: zoneKnown ? stampEventOffset(startAt, timezone) : startAt,
          endAt: zoneKnown ? stampEventOffset(endAt, timezone) : endAt,
          timezone,
          ...sheetText(row, idxDescription, idxVenueName),
          ...details.value,
          address: idxAddress === -1 ? null : nullableString(row[idxAddress] ?? ""),
          dressCodeDescription:
            idxDressDesc === -1 ? null : nullableString(row[idxDressDesc] ?? ""),
          dressCodePalette: idxPalette === -1 ? [] : parseDressCodePalette(row[idxPalette] ?? ""),
          pinterestUrl:
            idxPinterest === -1 ? null : (parseHttpUrl(row[idxPinterest] ?? "") ?? null),
          mapsUrl: idxMaps === -1 ? null : (parseHttpUrl(row[idxMaps] ?? "") ?? null),
          sortOrder: out.length,
        };
        if (id !== undefined) event.id = id;
        out.push(event);
        continue;
      }
      if (startAt.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Start is required",
            atRow: r + 1,
            atColumn: idxStart + 1,
          }),
        );
      }
      if (timezone.length === 0) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Timezone is required",
            atRow: r + 1,
            atColumn: idxTz + 1,
          }),
        );
      }
      // The zone has to resolve BEFORE the timestamps are stamped with the
      // offset derived from it — and a zone that doesn't resolve is a broken
      // event regardless: the guest site formats every event time with
      // `timeZone: event.timezone`, which throws on an unknown identifier.
      // `isKnownTimeZone` also rejects the fixed-offset spellings `Intl`
      // accepts ("+10:00", "UTC+10"), which never apply DST — the exact bug the
      // wall-clock model exists to end. It's the memoized twin of
      // `rsvp-deadline.ts`'s `isValidTimeZone`: this loop re-resolves
      // the SAME zone up to 3x per row (here, then twice more inside
      // `stampEventOffset` below), and an uncached `Intl.DateTimeFormat`
      // construction per lookup is real CPU across a large sheet.
      if (!isKnownTimeZone(timezone)) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Timezone must be an IANA timezone name",
            atRow: r + 1,
            atColumn: idxTz + 1,
          }),
        );
      }
      if (parseWallTime(startAt) === null) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Start must be an ISO-8601 timestamp",
            atRow: r + 1,
            atColumn: idxStart + 1,
          }),
        );
      }
      if (endAt.length > 0 && parseWallTime(endAt) === null) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "End must be an ISO-8601 timestamp",
            atRow: r + 1,
            atColumn: idxEnd + 1,
          }),
        );
      }

      const pinterestUrl = idxPinterest === -1 ? null : parseHttpUrl(row[idxPinterest] ?? "");
      if (pinterestUrl === undefined) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Pinterest URL must be an http(s) URL",
            atRow: r + 1,
            atColumn: idxPinterest + 1,
          }),
        );
      }
      const mapsUrl = idxMaps === -1 ? null : parseHttpUrl(row[idxMaps] ?? "");
      if (mapsUrl === undefined) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Maps URL must be an http(s) URL",
            atRow: r + 1,
            atColumn: idxMaps + 1,
          }),
        );
      }

      // Fidelity id — honoured only when the column is present AND the cell is
      // non-blank. A blank cell (e.g. a manually-added row in a full-fidelity
      // sheet) leaves the event id-less, so it falls back to name matching.
      const id =
        idxEventId === -1 ? undefined : (nullableString(row[idxEventId] ?? "") ?? undefined);

      const event: Types.Mutable<ParsedEvent> = {
        name,
        // The sheet states LOCAL time; the offset the stored timestamp carries
        // is derived from the Timezone column, never read out of the cell (see
        // `lib/event-time.ts`). So a `Start` of `2026-11-14T15:00` and a
        // `Timezone` of `Australia/Sydney` store `2026-11-14T15:00:00+11:00`,
        // DST resolved for that event's own date — and a stale `+10:00` left in
        // the cell by an older template is corrected rather than believed.
        startAt: stampEventOffset(startAt, timezone),
        endAt: stampEventOffset(endAt, timezone),
        timezone,
        ...sheetText(row, idxDescription, idxVenueName),
        ...details.value,
        address: idxAddress === -1 ? null : nullableString(row[idxAddress] ?? ""),
        dressCodeDescription: idxDressDesc === -1 ? null : nullableString(row[idxDressDesc] ?? ""),
        dressCodePalette: idxPalette === -1 ? [] : parseDressCodePalette(row[idxPalette] ?? ""),
        pinterestUrl,
        mapsUrl,
        sortOrder: out.length,
      };
      if (id !== undefined) event.id = id;
      out.push(event);
    }

    return out;
  }).pipe(
    // Stamp the sheet once, here, so every rejection above says WHICH file to fix.
    Effect.mapError(withSheet("events")),
    Effect.tapError((e) => Effect.sync(() => metricImportParseRejected(bucketParseReason(e._tag)))),
    Effect.withSpan("cire.import.parseEvents"),
  );
}

const REQUIRED_GUEST_COLUMNS = GUEST_SHEET_FIXED_HEADERS;

export interface ParseGuestsOptions {
  /**
   * The sheet is a checkpoint before-image (`stateExportService.guestsCsv(_,
   * "snapshot")`) that a revert is reading back — never an upload. Only
   * `services/revert.ts` passes it; the upload and apply paths never do.
   *
   * A snapshot is the app's own output, so it reads what the app stores rather
   * than what an upload may carry:
   *  - no row or cell cap (`parseCsv`, not `parseCsvBounded`) — the caps exist to
   *    bound an untrusted file, and a revert must not fail on a long value the
   *    editor accepted;
   *  - a household-only row (Family Name set, every guest cell and the Guest ID
   *    blank) is a household with no guests, which a guest-shaped sheet cannot
   *    otherwise describe;
   *  - a row carrying a `Guest ID` is a guest even when its first name is blank;
   *  - households are grouped by `Family ID` rather than by name, so two
   *    households with the same name stay two households;
   *  - no formula scan: the snapshot is written without the `'` guard, so a
   *    value such as `-12 Smith Street` comes back as stored;
   *  - the `Family Source` / `Guest Source` columns are read, so a row the
   *    revert re-creates keeps its provenance.
   */
  readonly snapshot?: boolean;
}

/** A before-image's `Guest Email Record` cell, compiled once per isolate. */
const decodeEmailRecord = Schema.decodeUnknownOption(Schema.fromJsonString(EmailRecord));

export function parseGuestsCsv(
  content: string,
  // Only the names are read: they are what the attendance columns must match.
  events: readonly Pick<ParsedEvent, "name">[],
  options: ParseGuestsOptions = {},
): Effect.Effect<DesiredFamily[], SpreadsheetParseError> {
  const snapshot = options.snapshot === true;
  return Effect.gen(function* () {
    const result: CsvParseResult = snapshot
      ? { ok: true, rows: parseCsv(content) }
      : parseCsvBounded(content);
    if (!result.ok) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: result.reason }));
    }
    if (result.rows.length === 0) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: "empty guests sheet" }));
    }

    if (!snapshot) {
      const formula = detectFormulaInjection(result.rows, 0);
      if (formula) return yield* Effect.fail(formula);
    }
    // A before-image is written without the guard, so it is read as written.
    const rows = snapshot ? result.rows : unguardRows(result.rows);
    if (!snapshot && !withinCellCap(rows)) {
      return yield* Effect.fail(new MalformedSpreadsheet({ reason: "cell too large" }));
    }

    const header = rows[0]!.map((h) => h.trim());
    const headerNorm = header.map(normaliseName);
    const indexOf = (label: string) => headerNorm.indexOf(normaliseName(label));

    for (const required of REQUIRED_GUEST_COLUMNS) {
      if (indexOf(required) === -1) {
        return yield* Effect.fail(new MissingRequiredColumn({ column: required }));
      }
    }

    const idxFamilyId = indexOf("Family ID");
    const idxFamilyName = indexOf("Family Name");
    const idxFirst = indexOf("Guest First Name");
    const idxLast = indexOf("Guest Last Name");
    // Optional: an informal name for the single-guest greeting. Absent ⇒ -1.
    const idxNickname = indexOf(GUEST_NICKNAME_HEADER);
    // Optional: the guest's address. Absent ⇒ -1, and then no row says
    // anything about addresses, so every stored one is left as it is.
    const idxEmail = indexOf(GUEST_EMAIL_HEADER);
    // Fixed (non-event) columns. Absent lookups are -1, which
    // `fixedCols.has(c)` (c ≥ 0) never matches.
    const fixedCols = new Set([
      idxFamilyId,
      idxFamilyName,
      idxFirst,
      idxLast,
      idxNickname,
      idxEmail,
    ]);

    // Map event-column index → canonical event name. Strict match — any
    // unmatched event column surfaces as `UnmatchedEventColumn`.
    const eventByNorm = new Map(events.map((e) => [normaliseName(e.name), e.name]));

    // Full-fidelity export/snapshot columns (Guest ID / Family Code), honoured
    // (they feed the ID-aware diff) under the collision contract below.
    //
    // COLLISION CONTRACT (must not change): an event may legitimately be
    // named after one of these reserved labels, making its attendance column
    // ambiguous. Resolve deterministically, biased against silently dropping
    // invitations: when the label is ALSO a known event name, only the LAST
    // header occurrence is fidelity metadata (the exporter appends fidelity
    // columns after the event columns), and a SINGLE occurrence stays the
    // event's attendance column. A label that matches no event is fidelity
    // metadata at every occurrence. `chosenFidelityIndex` records exactly which
    // occurrence we treat as metadata (or -1), so the honoured cell reads from
    // the same column the collision rule excludes from event matching.
    const fidelityCols = new Set<number>();
    const chosenFidelityIndex = (label: string): number => {
      const norm = normaliseName(label);
      const indices: number[] = [];
      headerNorm.forEach((h, i) => {
        if (h === norm) indices.push(i);
      });
      if (indices.length === 0) return -1;
      if (eventByNorm.has(norm)) {
        // Collision: only the last occurrence is metadata, and only when there
        // are ≥2 (a lone occurrence stays the event's attendance column).
        return indices.length >= 2 ? indices[indices.length - 1]! : -1;
      }
      // No collision: the (first) occurrence is metadata; mark all as fidelity.
      return indices[0]!;
    };
    const idxGuestId = chosenFidelityIndex(GUEST_ID_HEADER);
    const idxFamilyCode = chosenFidelityIndex(FAMILY_CODE_HEADER);
    // Provenance columns exist only in a snapshot; an upload reads them as
    // event columns like any other header.
    const idxFamilySource = snapshot ? chosenFidelityIndex(FAMILY_SOURCE_HEADER) : -1;
    const idxGuestSource = snapshot ? chosenFidelityIndex(GUEST_SOURCE_HEADER) : -1;
    const idxEmailRecord = snapshot ? chosenFidelityIndex(GUEST_EMAIL_RECORD_HEADER) : -1;
    const fidelityLabels = snapshot
      ? [
          GUEST_ID_HEADER,
          FAMILY_CODE_HEADER,
          FAMILY_SOURCE_HEADER,
          GUEST_SOURCE_HEADER,
          GUEST_EMAIL_RECORD_HEADER,
        ]
      : [GUEST_ID_HEADER, FAMILY_CODE_HEADER];
    for (const label of fidelityLabels) {
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

    // The `Family ID` fixed column carries an INTERNAL family id only under full
    // fidelity; the standard export writes neutral `fam-NNN` grouping keys the
    // parser must NOT treat as a stable id. Presence of the `Family Code`
    // fidelity column is the full-fidelity marker, so gate honouring `Family ID`
    // on it — a hand-authored or standard-export sheet (no Family Code column)
    // keeps the id-less, name-matched behaviour byte-identical to today.
    const honourFamilyId = idxFamilyId !== -1 && idxFamilyCode !== -1;

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

    // Group rows into households by (case+whitespace-normalised) family name —
    // or, in a snapshot, by Family ID. The first row's spelling wins; subsequent
    // rows just append guests.
    const families: DesiredFamily[] = [];
    const familyByKey = new Map<string, DesiredFamily>();
    // A before-image's consent record, or undefined for a blank or unreadable
    // cell — never a failure, so a damaged record cannot stop a revert.
    const recordAt = (idx: number, row: string[]): EmailRecord | undefined => {
      if (idx === -1) return undefined;
      const cell = (row[idx] ?? "").trim();
      if (cell.length === 0) return undefined;
      return Option.getOrUndefined(decodeEmailRecord(cell));
    };
    const provenanceAt = (idx: number, row: string[]): Provenance | undefined => {
      if (idx === -1) return undefined;
      const cell = (row[idx] ?? "").trim();
      return cell === "import" || cell === "manual" ? cell : undefined;
    };

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
            atRow: r + 1,
            atColumn: idxFamilyName + 1,
          }),
        );
      }

      const eventNames: string[] = [];
      for (const { idx, eventName } of eventColumns) {
        const cell = row[idx] ?? "";
        if (isTruthy(cell)) eventNames.push(eventName);
      }

      const nickname = idxNickname === -1 ? null : nullableString(row[idxNickname] ?? "");
      // The address: undefined when the sheet has no column (leave it as it
      // is), null for a blank cell (clear it), else the stored form. An upload
      // refuses a cell that is not one address, naming the cell, never its
      // text; a before-image is the app's own output and is read leniently, so
      // a value it cannot read leaves the address as it is.
      let email: string | null | undefined;
      if (idxEmail !== -1) {
        const cell = (row[idxEmail] ?? "").trim();
        const address = cell.length === 0 ? null : parseGuestEmail(cell);
        if (cell.length > 0 && address === null && !snapshot) {
          return yield* Effect.fail(
            new MalformedSpreadsheet({
              reason: "Guest Email is not a valid email address",
              atRow: r + 1,
              atColumn: idxEmail + 1,
            }),
          );
        }
        email = cell.length === 0 || address !== null ? address : undefined;
      }
      // Fidelity ids — honoured only when their column is present AND the cell is
      // non-blank (a blank cell = a manually-added row in a full-fidelity sheet,
      // which must stay id-less so it name-matches / creates). See the collision
      // + honourFamilyId gating above.
      const guestId =
        idxGuestId === -1 ? undefined : (nullableString(row[idxGuestId] ?? "") ?? undefined);
      const familyId = honourFamilyId
        ? (nullableString(row[idxFamilyId] ?? "") ?? undefined)
        : undefined;
      const publicId =
        idxFamilyCode === -1 ? undefined : (nullableString(row[idxFamilyCode] ?? "") ?? undefined);

      // Snapshot only (see ParseGuestsOptions): a row whose every guest cell is
      // blank describes a household with no guests.
      const householdOnly =
        snapshot &&
        guestId === undefined &&
        firstName.length === 0 &&
        lastName.length === 0 &&
        nickname === null &&
        (email === undefined || email === null) &&
        eventNames.length === 0;
      if (firstName.length === 0 && !householdOnly && !(snapshot && guestId !== undefined)) {
        return yield* Effect.fail(
          new MalformedSpreadsheet({
            reason: "Guest First Name is required",
            atRow: r + 1,
            atColumn: idxFirst + 1,
          }),
        );
      }

      const key =
        snapshot && familyId !== undefined ? `id:${familyId}` : `name:${normaliseName(familyName)}`;
      let family = familyByKey.get(key);
      if (!family) {
        const created: Types.Mutable<DesiredFamily> = {
          familyName,
          guests: [],
        };
        if (familyId !== undefined) created.id = familyId;
        if (publicId !== undefined) created.publicId = publicId;
        const familySource = provenanceAt(idxFamilySource, row);
        if (familySource !== undefined) created.source = familySource;
        family = created;
        familyByKey.set(key, family);
        families.push(family);
      }
      if (householdOnly) continue;

      const guest: Types.Mutable<DesiredGuest> = {
        firstName,
        lastName,
        nickname,
        eventNames,
      };
      if (guestId !== undefined) guest.id = guestId;
      const guestSource = provenanceAt(idxGuestSource, row);
      if (guestSource !== undefined) guest.source = guestSource;
      if (email !== undefined) guest.email = email;
      const emailRecord = recordAt(idxEmailRecord, row);
      if (emailRecord !== undefined) guest.emailRecord = emailRecord;
      // Mutate in place — the array reference is the same one in `families`.
      // The family's id/publicId come from its FIRST row; subsequent rows only
      // append guests, matching how the exporter writes one code per family.
      (family.guests as DesiredGuest[]).push(guest);
    }

    return families;
  }).pipe(
    Effect.mapError(withSheet("guests")),
    Effect.tapError((e) => Effect.sync(() => metricImportParseRejected(bucketParseReason(e._tag)))),
    Effect.withSpan("cire.import.parseGuests"),
  );
}
