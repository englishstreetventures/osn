// How an event's time is SHOWN in the host portal — the events table, the
// schedule editor's summary rows, anywhere an organiser reads a time back.
//
// The rule the whole portal now speaks: an event has a wall clock and an IANA
// zone, and NOTHING ELSE. The UTC offset the stored timestamp carries is an
// internal, always-derived detail (see `lib/timezones.ts` for the stamp, and
// `cire/api/src/lib/event-time.ts` for the sheet path's half of it) — printing
// it alongside the zone showed the organiser the same fact twice, in a form they
// couldn't edit and couldn't be expected to keep in step with the zone.
//
// So the raw stored string never reaches the screen: it is formatted into the
// event's own zone, and even the can't-parse-it fallback prints the wall clock
// with the offset stripped rather than the ISO value verbatim.

import { isDateOnly, splitIso } from "./event-datetime";

/** Module-scope formatter cache keyed by timezone — each zone's two formatters
 *  are constructed once and reused across every row and re-render (construction
 *  is the expensive half of ICU date handling; formatting an existing one is
 *  ~40× cheaper). Keyed on the event's stored zone, which the editor's dropdown
 *  and the import parser both constrain to real IANA identifiers, so the map is
 *  bounded by the tz database rather than by arbitrary input. */
const fmtCache = new Map<string, { dateFmt: Intl.DateTimeFormat; timeFmt: Intl.DateTimeFormat }>();

function getFormatters(timezone: string) {
  const cached = fmtCache.get(timezone);
  if (cached) return cached;
  const entry = {
    dateFmt: new Intl.DateTimeFormat("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: timezone,
    }),
    timeFmt: new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    }),
  };
  fmtCache.set(timezone, entry);
  return entry;
}

/** The wall clock a stored value names, with any offset dropped — the fallback
 *  spelling for a value `Intl` can't render (a half-filled draft: a date with no
 *  time yet; or a zone this browser's tz database doesn't know). Anything that
 *  isn't a timestamp at all is returned verbatim, since inventing a shape for it
 *  would hide what is actually stored. */
function wallClock(value: string): string {
  const { date, time } = splitIso(value);
  if (date.length === 0) return value;
  return time.length === 0 ? date : `${date} ${time}`;
}

/**
 * "Sat, 14 Nov 2026 · 3:00 pm – 4:00 pm" — an event's start (and end, when it
 * has one) as wall-clock times in its own zone. The ZONE ITSELF is not included:
 * callers show it separately, because a row that lists several events in one
 * zone shouldn't repeat it on every line.
 *
 * An `endAt` of "" is the "no stated end" sentinel and renders as just the
 * start.
 */
export function formatEventWhen(startAt: string, endAt: string, timezone: string): string {
  const raw = () =>
    endAt.trim().length === 0 ? wallClock(startAt) : `${wallClock(startAt)} – ${wallClock(endAt)}`;

  const start = new Date(startAt);
  // A date-only value is the drawer's half-filled state — a day picked, no time
  // yet. `Date` reads it as UTC midnight, so formatting it would put a made-up
  // clock time on screen ("11:00 am" for a Sydney event) and then a save would
  // be blocked by an error about a time the row appears to already have.
  if (isDateOnly(startAt) || Number.isNaN(start.getTime())) return raw();

  try {
    const { dateFmt, timeFmt } = getFormatters(timezone);
    const end = endAt.trim().length === 0 || isDateOnly(endAt) ? null : new Date(endAt);
    const endLabel = end === null || Number.isNaN(end.getTime()) ? "" : ` – ${timeFmt.format(end)}`;
    return `${dateFmt.format(start)} · ${timeFmt.format(start)}${endLabel}`;
  } catch {
    // An unresolvable zone — `Intl.DateTimeFormat` throws on construction. The
    // wall clock is still the honest answer; it just goes unlabelled.
    return raw();
  }
}
