// Split / recombine an event's ISO-8601-with-offset timestamp for the drawer
// form. Events store a single string like `2026-11-14T15:00:00+11:00` (see
// `lib/import-templates.ts`); the drawer edits it as a calendar date
// (`YYYY-MM-DD`) plus a wall-clock time (`HH:MM`), with the UTC offset DERIVED
// from the event's IANA timezone rather than typed (see `lib/timezones.ts`).
//
// This is pure string plumbing — no Date maths, so a value round-trips
// losslessly (we never reinterpret the offset). An unparseable/blank value
// yields empty parts so a new event starts clean.
//
// ## Why a date without a time survives
//
// `joinIso` used to collapse to "" whenever EITHER part was missing, and the
// drawer reads the date back out of the value it just wrote. On a new event
// (blank start), that made the date picker look broken: pick a day, the join
// sees no time, emits "", and the picker re-reads "" and goes back to "Pick a
// date…". Nothing an organiser could do with the picker alone had any effect.
//
// So a date with no time now round-trips as the bare `YYYY-MM-DD` — a PARTIAL
// value. It is deliberately not a valid timestamp: `isIsoTimestamp` rejects it,
// `validateDraft` reports "Start time is required", and Save stays disabled
// until the time is filled in. The half-entered state is visible and blocking
// rather than invisible and silent, and no invented midnight ever reaches the
// wire.

export interface DateTimeParts {
  /** `YYYY-MM-DD` or "" when unset. */
  date: string;
  /** `HH:MM` or "" when unset. */
  time: string;
  /** `+HH:MM` / `-HH:MM` / `Z` — the UTC offset. Defaults to `+00:00`. */
  offset: string;
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Split a stored ISO timestamp into editable parts. A date-only value (the
 *  partial a picked-but-untimed date leaves behind) yields that date with an
 *  empty time; a blank/malformed value yields empty date+time. Either way the
 *  offset falls back to a neutral `+00:00`. */
export function splitIso(value: string): DateTimeParts {
  const m = ISO_RE.exec(value.trim());
  if (!m) return { date: "", time: "", offset: "+00:00" };
  const [, date, time, rawOffset] = m;
  let offset = rawOffset ?? "+00:00";
  // Normalise `+1100` → `+11:00` for the offset field's expectations.
  if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return { date: date!, time: time ?? "", offset };
}

/**
 * Recombine parts into the canonical `YYYY-MM-DDTHH:MM:SS±HH:MM` string.
 *
 * With no date at all the value is "" — nothing has been chosen, which for an
 * End means "open-ended" and for a Start is the required-field case. With a
 * date but no time it is the bare date: a partial the validator flags (see the
 * header note), NOT a timestamp.
 */
export function joinIso(parts: DateTimeParts): string {
  const { date, time, offset } = parts;
  if (date.trim().length === 0) return "";
  if (time.trim().length === 0) return date.trim();
  const off = offset.trim().length === 0 ? "+00:00" : offset.trim();
  // Seconds are always `:00` — the editor works to minute precision, matching
  // the template rows and the guest-facing display.
  return `${date}T${time}:00${off === "Z" ? "Z" : off}`;
}

/** A value that names a day but no time — the partial {@link joinIso} emits
 *  while an organiser is halfway through filling a Start/End in. Lets the
 *  validator say "the time is missing" instead of the generic "not a valid
 *  date, time & timezone offset", which is true but unhelpful. */
export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}
