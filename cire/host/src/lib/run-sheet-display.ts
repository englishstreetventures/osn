// How a time on the day is SHOWN — on the run sheet and on a checklist row's
// time. Every time is read on its own clock: an event's in the event's zone, a
// task's in `runTimezone` (the event's, for a linked task). The browser's own
// zone never enters, so a helper reading the run sheet abroad sees the times
// the day runs on. Frontend code: no Effect.

import { isDateOnly, splitIso } from "./event-datetime";

/** A moment as the run sheet shows it, on one zone's clock. */
export interface ZonedTime {
  /** The local date there, `YYYY-MM-DD` — the day the row is grouped under. */
  date: string;
  /** "Sat 20 Jun", for a line that names the day. */
  day: string;
  /** "2:30 pm". */
  time: string;
  /** "AEST", "GMT+5:30"; the zone itself when the runtime cannot name it. */
  zone: string;
}

/** One formatter per zone, built on first use. Keyed on the zone as stored —
 *  the API checks every run-time zone against the tz database, and an event's
 *  is the editor's dropdown's or the import's — as `event-display.ts` keys its
 *  own. `null` marks a zone this runtime cannot resolve. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (formatters.has(zone)) return formatters.get(zone)!;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-AU", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: zone,
      timeZoneName: "short",
    });
  } catch {
    formatter = null;
  }
  formatters.set(zone, formatter);
  return formatter;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:30" → "2:30 pm", for the fallback that has no formatter. */
function twelveHour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

let weekdays: Intl.DateTimeFormat | undefined;

/** A day's short name from its date alone, read as a calendar day. */
function shortDay(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  weekdays ??= new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: "UTC" });
  return `${weekdays.format(at)} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/**
 * `iso` on `zone`'s clock, or null when it names no moment. A zone this
 * runtime cannot resolve falls back to the wall clock the stored value already
 * carries — every run time and event start is stamped in its own zone — rather
 * than to the browser's.
 */
export function zonedTime(iso: string, zone: string | null): ZonedTime | null {
  if (isDateOnly(iso)) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const formatter = zone ? formatterFor(zone) : null;
  if (formatter === null) {
    const { date, time, offset } = splitIso(iso);
    if (!date || !time) return null;
    return { date, day: shortDay(date), time: twelveHour(time), zone: zone ?? offset };
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  ) as Partial<Record<Intl.DateTimeFormatPartTypes, string>>;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    day: shortDay(date),
    time: `${parts.hour}:${parts.minute} ${parts.dayPeriod?.toLowerCase() ?? ""}`.trim(),
    zone: parts.timeZoneName ?? zone!,
  };
}

/** "Saturday 20 June", with the year when it is not this one. */
export function dayHeading(date: string, now = new Date()): string {
  const at = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: at.getUTCFullYear() === now.getFullYear() ? undefined : "numeric",
    timeZone: "UTC",
  }).format(at);
}

/** "45 min", "1 hr", "1 hr 30 min". */
export function spanOf(minutes: number): string {
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Where a linked task sits against its event: "45 min before Ceremony",
 *  "1 hr after Reception", "At the start of Speeches". */
export function offsetPhrase(offsetMinutes: number, eventName: string): string {
  if (offsetMinutes === 0) return `At the start of ${eventName}`;
  return `${spanOf(offsetMinutes)} ${offsetMinutes < 0 ? "before" : "after"} ${eventName}`;
}
