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

import { isSafeCssColor } from "@cire/theme";

import {
  MAX_RUN_OF_SHOW_LABEL,
  type ChildrenPolicy,
  type PaletteSwatch,
  type PlusOnePolicy,
  type RunOfShowItem,
} from "../schemas/import";

// ── Formula-injection markers ─────────────────────────────────────────────────

/** A cell that (after trimming) begins with one of these is run as a formula
 *  by Excel and Google Sheets — the full-width forms by East Asian builds of
 *  Excel. The download guard (`lib/csv.ts`) uses the same eight. */
const FORMULA_MARKERS = new Set(["=", "+", "-", "@", "\uff1d", "\uff0b", "\uff0d", "\uff20"]);

/**
 * Does an uploaded cell start a formula? The upload scan refuses such a cell.
 * Trims FIRST — leading whitespace is a known bypass (`" =SUM(...)"` is still
 * dangerous because sheet apps ignore the surrounding whitespace when
 * interpreting a formula).
 *
 * Narrower than the download guard (`sanitiseCsvCell` in `lib/csv.ts`), on
 * purpose: refusing every cell with a marker after an inner `;` or line break
 * would refuse a dress code written as a dash list. Stored values may therefore
 * hold a marker anywhere, and may start with one (the editor stores
 * `-12 Smith Street`; an upload's `'=x` imports as `=x`). Every download guards
 * them again; nothing else writes stored values into a spreadsheet.
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

// The Start/End cell rule USED to live here as `isIsoTimestamp`. It is now
// `parseWallTime` in `lib/event-time.ts`, because validating the cell's shape
// and reading the local date + time out of it are the same operation: an event's
// time is a WALL CLOCK plus an IANA zone, and the UTC offset the stored
// timestamp carries is DERIVED from that zone rather than typed. It is still a
// rule both front doors share (the sheet path calls it directly;
// `organiser/src/lib/guest-validation.ts` mirrors it), and it still carries the
// invariant it always did: `events.start_at`/`end_at` are compared LEXICALLY
// against a `YYYY-MM-DD` cutoff by the guest-data retention sweep
// (`services/retention.ts`), so a free-text date like "1st Nov 2026" (sorts
// below any `2…` cutoff) would make an upcoming wedding aggregate as expired and
// have its guest PII deleted, while "TBD" (sorts above) would never expire.

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
 * Malformed pairs (missing colon, blank name/colour, a colour off the
 * `isSafeCssColor` allow-list) are skipped, never thrown — a palette is
 * best-effort decoration, not a hard requirement.
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
    if (name.length === 0 || !isSafeCssColor(color)) continue;
    out.push({ name, color });
  }
  return out;
}

// ── An event's run of show and guest policy ──────────────────────────────────

/**
 * One line of a Run of Show cell: an hour of one or two digits, a colon, two
 * minute digits, then the label after whitespace. The time must stand alone
 * (`16:00Tea` has no label), so a label is never glued to its time.
 */
const RUN_OF_SHOW_LINE_RE = /^(\d{1,2}):(\d{2})(?:\s+([\s\S]*))?$/;

/** What one Run of Show line holds, or which rule it breaks. */
export type RunOfShowLine =
  | { readonly ok: true; readonly item: RunOfShowItem }
  | { readonly ok: false; readonly problem: "time" | "label" | "long" };

/**
 * Read one line of a Run of Show cell. The time is normalised to `HH:MM`, so
 * `4:05` is `04:05`; a reading the clock does not have (`25:00`, `16:75`) is
 * not a time. The label is trimmed and held to {@link MAX_RUN_OF_SHOW_LABEL}.
 * The caller skips blank lines.
 */
export function parseRunOfShowLine(line: string): RunOfShowLine {
  const m = RUN_OF_SHOW_LINE_RE.exec(line.trim());
  if (!m) return { ok: false, problem: "time" };
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return { ok: false, problem: "time" };
  const label = (m[3] ?? "").trim();
  if (label.length === 0) return { ok: false, problem: "label" };
  if (label.length > MAX_RUN_OF_SHOW_LABEL) return { ok: false, problem: "long" };
  return {
    ok: true,
    item: { time: `${String(hours).padStart(2, "0")}:${m[2]}`, label },
  };
}

/** A run of show as one sheet cell: one `HH:MM label` line per item, in order. */
export function runOfShowCell(items: readonly RunOfShowItem[]): string {
  return items.map((item) => `${item.time} ${item.label}`).join("\n");
}

/** Whether two runs of show hold the same items in the same order. */
export function sameRunOfShow(a: readonly RunOfShowItem[], b: readonly RunOfShowItem[]): boolean {
  return (
    a.length === b.length && a.every((x, i) => x.time === b[i]!.time && x.label === b[i]!.label)
  );
}

/** The words the events sheet uses for each children preset. */
export const CHILDREN_POLICY_LABEL = {
  adults_only: "Adults only",
  children_welcome: "Children welcome",
} as const satisfies Record<ChildrenPolicy, string>;

/** The words the events sheet uses for each plus-one preset. */
export const PLUS_ONE_POLICY_LABEL = {
  by_invitation: "By invitation",
  welcome: "Welcome",
} as const satisfies Record<PlusOnePolicy, string>;

/** The cell a sheet may hold for a preset nobody stated, beside a blank one. */
const NOT_STATED = "not stated";

/**
 * Read a Children or Plus-Ones cell: the preset whose words it holds (case and
 * spacing aside), `null` for a blank cell or "Not stated", and `undefined` for
 * anything else, which the caller refuses with the cell's position.
 */
export function presetFromCell<P extends string>(
  cell: string,
  labels: Readonly<Record<P, string>>,
): P | null | undefined {
  const norm = normaliseName(cell);
  if (norm.length === 0 || norm === NOT_STATED) return null;
  for (const [preset, label] of Object.entries(labels) as [P, string][]) {
    if (normaliseName(label) === norm) return preset;
  }
  return undefined;
}

// ── Required-field predicates ─────────────────────────────────────────────────
// Trivial-but-named so both front doors phrase "is this required field present?"
// identically. Each takes the already-trimmed value.

/** Event Name / Start / Timezone and Family Name / Guest First Name are the
 *  hard requirements — the minimum to render + reconcile a record. */
export function isBlank(trimmed: string): boolean {
  return trimmed.length === 0;
}
