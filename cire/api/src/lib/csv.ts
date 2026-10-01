/**
 * Shared CSV serialisation for the organiser exports (`rsvps.csv`,
 * `guests.csv`, `events.csv`, `gifts.csv`). Extracted from
 * `services/rsvp-export.ts` when the guests/events exports were added so every
 * download shares one formula-injection guard and one RFC 4180 serialiser.
 */

const FORMULA_MARKERS = new Set(["=", "+", "-", "@"]);

/**
 * Defuse CSV formula injection: a cell that (after trimming) starts with one of
 * `= + - @` is interpreted as a formula by Excel / Google Sheets when the file
 * is opened. Unlike the IMPORT side (which REJECTS such cells — they come from
 * an untrusted upload), the EXPORT contains guest-supplied data we still want to
 * surface, so we neutralise it by prefixing a single quote (`'`). The leading
 * whitespace is preserved after the quote so the displayed value is unchanged
 * apart from the guard. Mirrors the same `= + - @` marker set as
 * `cire/api/src/services/spreadsheet.ts`.
 */
export function sanitiseCsvCell(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed.length > 0 && FORMULA_MARKERS.has(trimmed[0]!)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180).
 * `guard` applies {@link sanitiseCsvCell} first; only a sheet no spreadsheet
 * tool will ever open may turn it off.
 */
export function csvField(value: string, guard = true): string {
  const safe = guard ? sanitiseCsvCell(value) : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export interface SerialiseCsvOptions {
  /**
   * Prefix `'` to a cell that starts with `= + - @` (default `true`). Every
   * download keeps it. A checkpoint before-image turns it off: it is stored for
   * the revert alone, never opened in a spreadsheet tool, and a guarded cell
   * would come back from a revert with the `'` still on it.
   */
  readonly guard?: boolean;
}

/**
 * Serialise a header + data rows into one CSV document — every cell
 * formula-sanitised (unless `guard: false`) + RFC 4180 quoted, CRLF line
 * endings (matching the import templates).
 */
export function serialiseCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: SerialiseCsvOptions = {},
): string {
  const guard = options.guard ?? true;
  const field = (cell: string) => csvField(cell, guard);
  const lines = [header.map(field).join(",")];
  for (const row of rows) {
    lines.push(row.map(field).join(","));
  }
  return lines.join("\r\n");
}
