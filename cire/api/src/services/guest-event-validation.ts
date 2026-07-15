/**
 * Shared guest + event validation rules — the ONE place the semantic rules that
 * gate a write live, so BOTH front doors of the reconcile pipeline (the CSV
 * import today, the editor draft-save in E5/E6) reject/accept identically.
 * Parser-parity is a design invariant (see [[guest-event-editor]] §3 / §9): the
 * sheet path (`services/spreadsheet.ts`, cell-level with row/column coords) and
 * the DesiredState path (field-level with entity paths) must never drift on what
 * they consider a valid value.
 *
 * This module is PURE — no Effect, no DB, no CSV framing. Each rule is a small
 * predicate/parser the two callers wrap with their own error shape. Extracting
 * them here does NOT change the sheet path's behaviour: `services/spreadsheet.ts`
 * imports these exact functions, so the parser's output stays byte-identical.
 *
 * SECURITY (reason lockdown): every human-facing rejection reason is a STATIC
 * string literal (see the reason unions in `services/spreadsheet.ts`). Rules
 * here return booleans / `undefined` sentinels, never interpolated cell
 * contents, so a hostile uploaded sheet can never inject text into an API body.
 */

import type { PaletteSwatch } from "../schemas/import";

// ── Formula-injection markers ─────────────────────────────────────────────────

/**
 * A cell that (after trimming) begins with one of these is interpreted as a
 * formula by Excel / Google Sheets. On the IMPORT side these are REJECTED (the
 * upload is untrusted); the EXPORT side neutralises them instead (`lib/csv.ts`).
 * Shared here so the marker set is defined once.
 */
export const FORMULA_MARKERS = new Set(["=", "+", "-", "@"]);

/**
 * Does a cell start a formula? Trims FIRST — leading whitespace is a known
 * bypass (`" =SUM(...)"` is still dangerous because sheet apps ignore the
 * surrounding whitespace when interpreting a formula).
 */
export function isFormulaCell(cell: string): boolean {
  const trimmed = cell.trim();
  return trimmed.length > 0 && FORMULA_MARKERS.has(trimmed[0]!);
}

// ── Name normalisation ────────────────────────────────────────────────────────

/**
 * Normalise a header / event-name / family-name for case+whitespace-insensitive
 * matching. The one canonical spelling of "same name" across the parser, the
 * diff, and the exporter — a drift here would split or merge records wrongly.
 */
export function normaliseName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// ── Cell-value rules ──────────────────────────────────────────────────────────

/**
 * Validate a Start/End cell as an ISO-8601 timestamp: a zero-padded
 * `YYYY-MM-DDTHH:MM` prefix AND parseable by `Date`. The prefix check is
 * load-bearing beyond display: `events.start_at`/`end_at` are compared LEXICALLY
 * against a `YYYY-MM-DD` cutoff by the guest-data retention sweep
 * (`services/retention.ts`), so a free-text date like "1st Nov 2026" (sorts
 * below any `2…` cutoff) would make an upcoming wedding aggregate as expired and
 * have its guest PII deleted, while "TBD" (sorts above) would never expire.
 * Enforcing the shape at every ingest point makes the sweep's invariant true.
 */
export function isIsoTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(new Date(s).getTime());
}

/** Truthy tokens for an attendance cell. */
const TRUTHY = new Set(["true", "yes", "1", "x"]);

/** Is an attendance cell truthy (invited)? Case + whitespace insensitive. */
export function isTruthy(s: string): boolean {
  return TRUTHY.has(s.trim().toLowerCase());
}

/** Trim to a non-empty string or `null` when blank/whitespace-only. */
export function nullableString(s: string): string | null {
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a URL cell into a trimmed http(s) string, or `null` when blank.
 * Returns `undefined` for a present-but-non-http(s) value so the caller can
 * reject it with positional context — a `javascript:` href would otherwise
 * reach the organiser UI and XSS.
 */
export function parseHttpUrl(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a Dress Code Palette cell (`Name:#rgb|Name:#rgb`) into swatches.
 * Malformed pairs (missing colon, blank name/colour) are skipped, never thrown —
 * a palette is best-effort decoration, not a hard requirement.
 */
export function parseDressCodePalette(raw: string): PaletteSwatch[] {
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

// ── Required-field predicates ─────────────────────────────────────────────────
// Trivial-but-named so both front doors phrase "is this required field present?"
// identically. Each takes the already-trimmed value.

/** Event Name / Start / Timezone and Family Name / Guest First Name are the
 *  hard requirements — the minimum to render + reconcile a record. */
export function isBlank(trimmed: string): boolean {
  return trimmed.length === 0;
}
