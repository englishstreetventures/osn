/**
 * Shared CSV serialisation for every organiser download (`rsvps.csv`,
 * `guests.csv`, `events.csv`, `gifts.csv`, `budget.csv`, `tasks.csv` and the
 * round-trip `export/*.csv`): one formula-injection guard, one RFC 4180
 * serialiser, and the guard's exact inverse for the import that reads a
 * round-trip file back (`services/spreadsheet.ts`).
 */

/**
 * Where a spreadsheet may start a new cell inside one CSV field. Excel set to
 * `;` as its list separator (most continental-European settings) splits a
 * comma-separated line on `;`, and on a line break inside a quoted field whose
 * `"` is not at the start of a `;` segment; a tab-separated reading splits on
 * tabs. So the start of every segment after one of these is a cell start to
 * some reader.
 */
const SEGMENT_BREAK = /[;\t\r\n]/g;

/**
 * What a spreadsheet may skip, or never show, before it decides whether a cell
 * is a formula: whitespace, control characters and format characters
 * (zero-width spaces and joiners, bidi controls, the soft hyphen, the byte-order
 * mark). Matched one code point at a time, so a format character outside the
 * Basic Multilingual Plane counts too.
 */
const SKIPPED_WIDE = /^[\s\p{Cc}\p{Cf}]/u;

/** Length of the skipped character at `at` (0, 1 or 2 UTF-16 units). */
function skippedLength(value: string, at: number): number {
  const code = value.charCodeAt(at);
  // ASCII controls and space; and `"`, which a `;`-separated reading can take
  // as an empty quoted value with the rest of the segment after it.
  if (code <= 0x20 || code === 0x22) return 1;
  if (code < 0x7f) return 0;
  const match = SKIPPED_WIDE.exec(value.slice(at, at + 2));
  return match ? match[0].length : 0;
}

/**
 * The characters that start a formula: `=`, `+`, `-`, `@`, and their
 * full-width forms (U+FF1D, U+FF0B, U+FF0D, U+FF20), which East Asian builds
 * of Excel can read as a formula start too.
 */
const isFormulaMarker = (code: number): boolean =>
  code === 0x3d ||
  code === 0x2b ||
  code === 0x2d ||
  code === 0x40 ||
  code === 0xff1d ||
  code === 0xff0b ||
  code === 0xff0d ||
  code === 0xff20;

/** The index just past the run of skipped characters that starts at `start`. */
function pastSkipped(value: string, start: number): number {
  const end = value.length;
  let at = start;
  for (let skip = 0; at < end && (skip = skippedLength(value, at)) > 0;) at += skip;
  return at;
}

/**
 * Whether zero or more `'` and then a formula marker start at `at`.
 *
 * The `'` run is part of the pattern so the guard can be undone exactly: a
 * value that already reads `'=x` is written `''=x`, and the import takes one
 * quote off either.
 */
function startsFormula(value: string, at: number): boolean {
  let marker = at;
  while (marker < value.length && value.charCodeAt(marker) === 0x27) marker++;
  return marker < value.length && isFormulaMarker(value.charCodeAt(marker));
}

const NO_INDEXES: readonly number[] = [];

/**
 * Every index the guard writes a `'` at, ascending, each once: the end of the
 * skipped run of every segment that then starts a formula.
 *
 * Tab, CR and LF are both segment breaks and skipped characters, so a skipped
 * run can hold many breaks (`\r\n`, blank lines), and each of them reaches the
 * same marker. The search for the next break therefore starts past the run,
 * which takes that marker one quote and keeps the walk linear in the value's
 * length: a cell of nothing but line breaks costs one pass, not one per break.
 */
function guardIndexes(value: string): readonly number[] {
  let indexes: number[] | undefined;
  let start = 0;
  for (;;) {
    const at = pastSkipped(value, start);
    if (startsFormula(value, at)) (indexes ??= []).push(at);
    SEGMENT_BREAK.lastIndex = at;
    if (!SEGMENT_BREAK.test(value)) break;
    start = SEGMENT_BREAK.lastIndex;
  }
  return indexes ?? NO_INDEXES;
}

/**
 * Defuse CSV formula injection. A cell whose start, or the start of any `;`,
 * tab, CR or LF segment inside it, is a formula marker (`= + - @`, or a
 * full-width form of one) after any
 * whitespace, control or format characters gets a `'` immediately before that
 * marker, so a spreadsheet reads the segment as text whatever separator it
 * splits on. Everything else in the value is kept, so what the organiser sees
 * differs only by the quotes.
 *
 * The UPLOAD side is narrower on purpose: it refuses a cell that starts with a
 * marker (`isFormulaCell` in `services/guest-event-validation.ts`), and then
 * takes this guard back off with {@link unguardCsvCell}. Stored values may
 * therefore start with a marker, and every download relies on this guard.
 */
export function sanitiseCsvCell(value: string): string {
  const indexes = guardIndexes(value);
  if (indexes.length === 0) return value;
  let out = "";
  let from = 0;
  for (const at of indexes) {
    out += `${value.slice(from, at)}'`;
    from = at;
  }
  return out + value.slice(from);
}

/**
 * The exact inverse of {@link sanitiseCsvCell}: one `'` comes off at every
 * place the guard would have put one, and nothing else changes, so
 * `unguardCsvCell(sanitiseCsvCell(v)) === v` for every `v`. The import applies
 * it to a round-trip sheet after its formula scan, so an exported value comes
 * back as stored. A cell typed as `'=x` in a hand-made sheet imports as `=x`.
 */
export function unguardCsvCell(value: string): string {
  // Only a `'` is ever removed, so a cell without one comes back as it is.
  if (!value.includes("'")) return value;
  const indexes = guardIndexes(value);
  if (indexes.length === 0) return value;
  let out = "";
  let from = 0;
  for (const at of indexes) {
    if (value.charCodeAt(at) !== 0x27) continue;
    out += value.slice(from, at);
    from = at + 1;
  }
  return out + value.slice(from);
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
   * Apply {@link sanitiseCsvCell} to every cell (default `true`). Every
   * download keeps it. A checkpoint before-image turns it off: it is stored for
   * the revert alone, never opened in a spreadsheet tool, and its reader takes
   * every value as written.
   */
  readonly guard?: boolean;
}

/**
 * Serialise a header + data rows into one CSV document — every cell, header
 * included, formula-guarded (unless `guard: false`) + RFC 4180 quoted, CRLF
 * line endings (matching the import templates).
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
