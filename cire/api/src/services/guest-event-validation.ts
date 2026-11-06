/**
 * Shared guest + event validation rules — the ONE place the semantic rules that
 * gate a write live, so BOTH front doors of the reconcile pipeline (the CSV
 * import today, the editor draft-save in E5/E6) reject/accept identically.
 * Parser-parity is a design invariant (see [[guest-event-editor]] §3 / §9): the
 * sheet path (`services/spreadsheet.ts`, cell-level with row/column coords) and
 * the DesiredState path (field-level with entity paths) must never drift on what
 * they consider a valid value. The editor door holds a value to them where a
 * save sets it, and takes one a save leaves as stored (`refusedEventFields`).
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

import { isEventInstant, isKnownTimeZone } from "../lib/event-time";
import {
  MAX_RUN_OF_SHOW_LABEL,
  type ChildrenPolicy,
  type PaletteSwatch,
  type ParsedEvent,
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

// The Start/End rule lives in `lib/event-time.ts`, because validating the value's
// shape and reading the local date + time out of it are the same operation: an
// event's time is a WALL CLOCK plus an IANA zone, and the UTC offset the stored
// timestamp carries is DERIVED from that zone rather than typed. Both front
// doors share it: the sheet path calls `parseWallTime` and stamps the offset;
// the editor door calls `isEventInstant` (through `refusedEventFields` below),
// which also requires the offset the editor stamped;
// `cire/host/src/lib/guest-validation.ts` mirrors both. `events.start_at`/`end_at`
// are compared LEXICALLY against a `YYYY-MM-DD` cutoff by the guest-data
// retention sweep (`services/retention.ts`), so a stored value must begin with
// its date.

/** The event fields an editor save is held to only where it sets them. */
export type HeldEventField = "name" | "startAt" | "endAt" | "timezone";

/** In the order a refusal names them. */
export const HELD_EVENT_FIELDS: readonly HeldEventField[] = [
  "name",
  "startAt",
  "endAt",
  "timezone",
];

/**
 * The rule each held field must pass to be stored as an editor save sends it:
 * a name that is not blank; a Start that is an instant whose text begins with
 * its date; an End that is `""` (no stated end) or such an instant; a zone the
 * Worker resolves. The sheet door stores the same values after its parser has
 * stamped the offset. A name may start with a formula marker (`+1 Drinks`), as
 * the sheet stores one once it has taken the download's `'` guard back off.
 */
export const HELD_EVENT_RULES = {
  name: (s: string) => s.trim().length > 0,
  startAt: isEventInstant,
  endAt: (s: string) => s === "" || isEventInstant(s),
  timezone: isKnownTimeZone,
} as const satisfies Readonly<Record<HeldEventField, (value: string) => boolean>>;

/**
 * The held fields of an editor-save event that fail their rule and differ from
 * the values stored on the event it updates. `stored` is that event's row as
 * the diff matched it, or undefined for an event the save adds, whose every
 * field is held. A field equal to the stored one passes as stored: a row saved
 * before these rules can hold a value they refuse, and a save that leaves it
 * alone must not be refused for it. A stored field the caller did not read is
 * undefined, so it never matches and the field is held.
 *
 * One field is held for another's sake: a Start, or an End other than `""`,
 * that the save sets holds the zone too, changed or not. Its offset is
 * derived from the zone, and on a zone that does not resolve the portal can
 * only keep the stored offset or guess one, which `isEventInstant` cannot tell
 * from the right one.
 */
export function refusedEventFields(
  event: Pick<ParsedEvent, HeldEventField>,
  stored: Partial<Pick<ParsedEvent, HeldEventField>> | undefined,
): HeldEventField[] {
  const changed = (field: HeldEventField) => event[field] !== stored?.[field];
  const setsTime = changed("startAt") || (changed("endAt") && event.endAt !== "");
  return HELD_EVENT_FIELDS.filter(
    (field) =>
      (changed(field) || (field === "timezone" && setsTime)) &&
      !HELD_EVENT_RULES[field](event[field]),
  );
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

/**
 * A line that starts with a 12-hour time: `4:00 pm`, `12:30 a.m.`, `4pm`. Read
 * as 24-hour, every afternoon item would land twelve hours early. An hour over
 * 12 cannot be on a 12-hour clock, so `16:00 PM speech` is a time and a label.
 */
const TWELVE_HOUR_RE = /^(\d{1,2})(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?=\s|$)/i;

/** Whether a Run of Show line starts with a 12-hour time, which the sheet refuses. */
export function startsWithTwelveHourTime(line: string): boolean {
  const m = TWELVE_HOUR_RE.exec(line.trim());
  return m !== null && Number(m[1]) <= 12;
}

/** What one Run of Show line holds, or which rule it breaks. */
type RunOfShowLine =
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

/**
 * An editor-door event with its text held to the sheet door's rules: the
 * description and each run-of-show label trimmed, and a blank venue name,
 * getting-there note or policy note null. So a download of what an editor
 * save stored re-imports without a change or a warning. Absent fields stay
 * absent.
 */
export function tidyEditorEvent(event: ParsedEvent): ParsedEvent {
  /** A note as the sheet reads one: trimmed, and blank is none. */
  const note = (text: string | null | undefined) => (text == null ? text : nullableString(text));
  return {
    ...event,
    ...(event.description !== undefined && { description: event.description.trim() }),
    ...(event.venueName !== undefined && { venueName: note(event.venueName) }),
    ...(event.gettingThere !== undefined && { gettingThere: note(event.gettingThere) }),
    ...(event.guestPolicyNote !== undefined && { guestPolicyNote: note(event.guestPolicyNote) }),
    ...(event.runOfShow !== undefined && {
      runOfShow: event.runOfShow.map((item) => ({ time: item.time, label: item.label.trim() })),
    }),
  };
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
