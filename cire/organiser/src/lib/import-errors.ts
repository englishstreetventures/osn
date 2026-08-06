/**
 * Turn a spreadsheet-import API failure into something an organiser can act on.
 *
 * The API works hard to locate a bad cell — it reports a `reason`, a 1-indexed
 * `row`/`column`, and which `sheet` the failure came from — and the panel used
 * to throw all of it away, rendering only the top-level `error`. The result was
 * a bare "Malformed spreadsheet" for fourteen genuinely different problems, with
 * no hint of which of two files to open, which row, or what to change.
 *
 * This module is the other half of that contract: every field the API sends is
 * spent on a sentence that says WHERE the problem is, WHAT is wrong, and HOW to
 * fix it. The wordings mirror the parser in `cire/api/src/services/spreadsheet.ts`
 * (`MalformedSpreadsheetReason` is a closed union there, so this switch is
 * exhaustive against it) — a new reason added there wants a case added here, and
 * falls back to the raw reason text until it gets one.
 */

/** The `sheet` discriminator the API stamps on a parse error. */
export type SheetKind = "events" | "guests";

/**
 * The JSON body of a failed import request.
 *
 * `column` is deliberately loose: for `Missing required column` / `Unmatched
 * event column` it is the header LABEL (a string), and for the positional
 * failures it is a 1-indexed column NUMBER. Callers dispatch on `error` first,
 * so each branch knows which it is holding.
 */
export interface ImportErrorBody {
  error?: string;
  reason?: string;
  row?: number | null;
  column?: number | string | null;
  sheet?: SheetKind | null;
  /** Capacity (402) detail. */
  limit?: number;
  current?: number;
}

const SHEET_LABEL: Record<SheetKind, string> = {
  events: "your events sheet",
  guests: "your guests sheet",
};

/**
 * Explicit two-value check rather than `SHEET_LABEL[sheet]`. The body is cast
 * from `res.json()`, so `sheet` is unvalidated at runtime — indexing a record
 * with it would happily return an inherited prototype key (`"constructor"`
 * yields a function, which `capitalise()` then throws on).
 */
function sheetLabel(sheet: SheetKind | null | undefined): string | null {
  return sheet === "events" || sheet === "guests" ? SHEET_LABEL[sheet] : null;
}

/**
 * "Your events sheet, row 4, column 2" — as much of the location as the API
 * gave us, and `null` when it gave us none (a whole-file failure with only one
 * sheet in flight needs no prefix).
 */
function locate(body: ImportErrorBody): string | null {
  const parts: string[] = [];
  const sheet = sheetLabel(body.sheet);
  if (sheet) parts.push(`In ${sheet}`);
  if (typeof body.row === "number") parts.push(`row ${body.row}`);
  if (typeof body.column === "number") parts.push(`column ${body.column}`);
  if (parts.length === 0) return null;
  return parts.join(", ");
}

/** Prefix `detail` with the location when there is one. */
function at(body: ImportErrorBody, detail: string): string {
  const where = locate(body);
  return where ? `${where} — ${detail}` : detail;
}

/**
 * The per-reason guidance for a `Malformed spreadsheet` 422. Each case answers
 * "what do I actually change?", because the reason alone ("Start must be an
 * ISO-8601 timestamp") names a format an organiser has never heard of.
 */
function malformedDetail(body: ImportErrorBody): string {
  const sheet = sheetLabel(body.sheet) ?? "that sheet";
  switch (body.reason) {
    case "too many rows":
      return `${capitalise(sheet)} has more than 5,000 rows, which is the most one import can carry.`;
    case "cell too large":
      return at(
        body,
        "this cell is longer than 10,000 characters. That's usually an accidental paste of a whole document into one cell.",
      );
    case "unterminated quoted cell":
      return `A quoted cell in ${sheet} is never closed — there's an odd number of " marks in the file, so everything after it reads as one giant cell. This normally comes from a stray quote inside an address or a dress-code note. Re-saving the file from your spreadsheet app (rather than editing it as text) will fix the quoting for you.`;
    case "empty events sheet":
    case "empty guests sheet":
      return "That file is empty. Check you picked the right file — it needs at least the header row.";

    // Required cells. The parser skips rows where EVERY cell is blank, so
    // hitting this means the row has something in it — often an invisible
    // leftover space — which is worth saying, since the row looks empty.
    case "Event Name is required":
    case "Start is required":
    case "Timezone is required":
    case "Family Name is required":
    case "Guest First Name is required":
      return at(
        body,
        `${body.reason.replace(" is required", "")} can't be blank. If this looks like a leftover empty row, delete the whole row — a row is only skipped when every single cell in it is empty.`,
      );

    case "Start must be an ISO-8601 timestamp":
    case "End must be an ISO-8601 timestamp":
      return at(
        body,
        `${body.reason.startsWith("Start") ? "Start" : "End"} must look like 2026-11-14T15:00 — the date, then a T, then the local time. There's no UTC offset to work out: the Timezone column next to it says which clock that time is on. Watch out for spreadsheet apps: opening the file in Excel, Numbers or Sheets can silently rewrite that cell as something like 14/11/2026 15:00. Format the column as plain text before typing the value, or retype it after.`,
      );

    // The zone is what turns a local time into a real moment, so it has to be an
    // identifier the runtime knows — not an abbreviation, and not an offset.
    case "Timezone must be an IANA timezone name":
      return at(
        body,
        `Timezone must be an IANA zone name like Australia/Sydney, Asia/Kolkata or Europe/London — Region/City, matching the list the events editor offers. Abbreviations ("AEST"), country names and raw offsets ("+11:00") aren't zones: an offset can't know about daylight saving, so it would be an hour out for half the year.`,
      );

    case "Pinterest URL must be an http(s) URL":
    case "Maps URL must be an http(s) URL":
      return at(
        body,
        `${body.reason.startsWith("Pinterest") ? "Pinterest URL" : "Maps URL"} must be a full link starting with https:// — paste the whole address out of your browser's address bar. Leave the cell blank if you don't have one.`,
      );

    default:
      // Forward-compatible: a reason this build doesn't know about still shows
      // the server's text and its location rather than collapsing to nothing.
      return at(body, body.reason ?? "that sheet couldn't be read.");
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The organiser-facing message for a failed preview/apply. Falls back to the
 * API's own `error` string (then to the status code) for anything unrecognised,
 * so a new server-side failure is never rendered as an empty box.
 */
export function formatImportError(status: number, body: ImportErrorBody): string {
  switch (body.error) {
    case "Malformed spreadsheet":
      return malformedDetail(body);

    case "Missing required column": {
      const sheet = sheetLabel(body.sheet) ?? "your sheet";
      return `${capitalise(sheet)} has no "${String(body.column)}" column. The header row has to be the very first row of the file, with the column names spelled as in the template — download the template above to compare.`;
    }

    case "Unmatched event column": {
      const sheet = sheetLabel(body.sheet) ?? "your guests sheet";
      return `"${String(body.column)}" in ${sheet} doesn't match any of your events. Every column after the fixed ones is read as an event's attendance column, so its heading has to be an event name exactly. If this is a new event, add it first — upload your events sheet, or add it on the Schedule tab — then upload your guests.`;
    }

    case "Formula-injection guard tripped":
      return at(
        body,
        "this cell starts with =, +, - or @. Spreadsheet apps treat those as the start of a formula, so Cire won't accept them. Edit the cell so it begins with something else.",
      );

    case "payment_required":
      return typeof body.limit === "number"
        ? `This import would take you past your plan's limit of ${body.limit} guests. Remove some guests from the sheet, or upgrade your plan.`
        : "This import would take you past your plan's guest limit.";
  }

  // Non-parse failures that still deserve a plain-English line.
  if (status === 413) {
    return "That upload is too large — the limit is 1 MB per import. If your guest list is genuinely that big, split it into two uploads.";
  }
  if (status === 409 && body.error?.startsWith("State changed")) {
    return "Someone else changed this wedding while you were previewing. Press Preview again to see a fresh diff before applying.";
  }

  return body.error ?? `Request failed (${status})`;
}
