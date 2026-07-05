/**
 * Shared CSV serialisation for the organiser exports (`rsvps.csv`,
 * `guests.csv`, `events.csv`). Extracted from `services/rsvp-export.ts` when
 * the guests/events exports were added so all three downloads share one
 * formula-injection guard and one RFC 4180 serialiser.
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

/** Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180). */
export function csvField(value: string): string {
  const safe = sanitiseCsvCell(value);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Serialise a header + data rows into one CSV document — every cell
 * formula-sanitised + RFC 4180 quoted, CRLF line endings (matching the import
 * templates).
 */
export function serialiseCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\r\n");
}
