// Split / recombine an event's ISO-8601-with-offset timestamp for the drawer
// form. Events store a single string like `2026-11-14T15:00:00+11:00` (see
// `lib/import-templates.ts`); the drawer edits it as three friendly parts — a
// calendar date (`YYYY-MM-DD`), a wall-clock time (`HH:MM`), and a UTC offset
// (`+11:00` / `-05:00` / `Z`). Recombining always emits the parser's canonical
// shape so `isIsoTimestamp` (client + server) accepts it.
//
// This is pure string plumbing — no Date maths, so a value round-trips
// losslessly (we never reinterpret the offset). An unparseable/blank value
// yields empty parts so a new event starts clean.

export interface DateTimeParts {
  /** `YYYY-MM-DD` or "" when unset. */
  date: string;
  /** `HH:MM` or "" when unset. */
  time: string;
  /** `+HH:MM` / `-HH:MM` / `Z` — the UTC offset. Defaults to `+00:00`. */
  offset: string;
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Split a stored ISO timestamp into editable parts. A blank/malformed value
 *  yields empty date+time (so the drawer shows empty fields) with a neutral
 *  `+00:00` offset. */
export function splitIso(value: string): DateTimeParts {
  const m = ISO_RE.exec(value.trim());
  if (!m) return { date: "", time: "", offset: "+00:00" };
  const [, date, time, rawOffset] = m;
  let offset = rawOffset ?? "+00:00";
  // Normalise `+1100` → `+11:00` for the offset field's expectations.
  if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return { date: date!, time: time!, offset };
}

/** Recombine parts into the canonical `YYYY-MM-DDTHH:MM:SS±HH:MM` string, or ""
 *  when the date or time is missing (an incomplete value the validator will then
 *  flag as required, rather than a half-formed timestamp). */
export function joinIso(parts: DateTimeParts): string {
  const { date, time, offset } = parts;
  if (date.trim().length === 0 || time.trim().length === 0) return "";
  const off = offset.trim().length === 0 ? "+00:00" : offset.trim();
  // Seconds are always `:00` — the editor works to minute precision, matching
  // the template rows and the guest-facing display.
  return `${date}T${time}:00${off === "Z" ? "Z" : off}`;
}

/** The offset options the drawer offers — the common Australian + a few global
 *  zones, plus UTC. A free-form value already stored (from an import) is
 *  preserved by {@link splitIso}; the picker just covers the frequent cases. */
export const OFFSET_OPTIONS = [
  "+11:00",
  "+10:00",
  "+09:30",
  "+08:00",
  "+05:30",
  "+01:00",
  "+00:00",
  "-05:00",
  "-08:00",
  "Z",
] as const;
