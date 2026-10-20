/**
 * Helpers for the holistic event-details view. Pure, framework-free, and
 * timezone-aware — the modal stays declarative and these stay unit-testable.
 *
 * Cire stores `startAt` / `endAt` as ISO strings (with offset) plus an IANA
 * `timezone`, and a venue as an optional name, a free-form `address` and an
 * optional `mapsUrl`. There are NO stored lat/lng coordinates, so every
 * "where" affordance below is derived from those alone — no map API key, no
 * network call.
 */
import { invitedMembers } from "./plus-one";
import type { EventSummary, FamilyMember } from "./types";

/**
 * One `Intl.DateTimeFormat` per locale and set of options, the zone included.
 * Building a formatter costs far more than calling one, and a sheet's lines ask
 * for the same few again and again. The map is bounded: a zone that does not
 * exist throws before anything is stored, so its keys come from the IANA zones
 * times the handful of option sets in this file.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale} ${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

/** The trimmed text, or null when there is none. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The venue's street address, trimmed, or null when unset. */
export function venueLine(event: Pick<EventSummary, "address">): string | null {
  return text(event.address);
}

/** The venue's name ("The Grounds of Alexandria"), trimmed, or null when unset. */
export function venueName(event: Pick<EventSummary, "venueName">): string | null {
  return text(event.venueName);
}

/**
 * What a map is asked to find: the address, which is the precise place, and
 * the venue's name when there is no address. Null when there is neither.
 */
export function venueQuery(event: Pick<EventSummary, "address" | "venueName">): string | null {
  return venueLine(event) ?? venueName(event);
}

/**
 * The venue as one line for a calendar entry: "The Glasshouse, 12 Banksia
 * Lane". The name alone when there is no address, the address alone when
 * there is no name or when the address already starts with it as a whole word
 * or words (an organiser who typed the name into both), and `""` when there is
 * neither.
 */
export function venueLocation(event: Pick<EventSummary, "address" | "venueName">): string {
  const name = venueName(event);
  const address = venueLine(event);
  if (!name) return address ?? "";
  if (!address) return name;
  const repeats =
    address.toLowerCase().startsWith(name.toLowerCase()) &&
    !/^[\p{L}\p{N}]/u.test(address.slice(name.length));
  return repeats ? address : `${name}, ${address}`;
}

/**
 * Format the event's calendar day in its own timezone, e.g. "Friday, 18 September 2026".
 * Reads the wall-clock day in `timezone` so a late-evening event in a +10 zone
 * never rolls back to the previous UTC day.
 */
export function formatEventDay(event: Pick<EventSummary, "startAt" | "timezone">): string {
  const date = new Date(event.startAt);
  if (Number.isNaN(date.getTime())) return "";
  return formatter("en-AU", {
    timeZone: event.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** A parsed instant, or null for an empty or unparseable string. */
function instant(iso: string): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A wall-clock time in `timeZone`, e.g. "4:00 pm". */
function clock(date: Date, timeZone: string): string {
  return formatter("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** The calendar day of an instant in `timeZone`, as a sortable `YYYY-MM-DD`. */
function dayKey(date: Date, timeZone: string): string {
  return formatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Whole calendar days from one `YYYY-MM-DD` to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "Fri", or "Fri, 13 Nov" once a weekday alone could name two days. */
function dayLabel(date: Date, timeZone: string, withDate: boolean): string {
  const options: Intl.DateTimeFormatOptions = { timeZone, weekday: "short" };
  if (withDate) {
    options.day = "numeric";
    options.month = "short";
  }
  return formatter("en-AU", options).format(date);
}

/** The short name of `timeZone` at `date`, e.g. "AEDT" or "GMT+5:30". */
function zoneLabel(date: Date, timeZone: string): string {
  return (
    formatter("en-AU", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? ""
  );
}

/** Short timezone label for the event instant, e.g. "AEST" / "GMT+10". */
export function timezoneLabel(event: Pick<EventSummary, "startAt" | "timezone">): string {
  const date = instant(event.startAt);
  return date ? zoneLabel(date, event.timezone) : "";
}

/**
 * The place an IANA zone is named after — "Australia/Sydney" → "Sydney",
 * "America/Argentina/Buenos_Aires" → "Buenos Aires". Null for a zone named
 * after no place: "UTC", and the fixed offsets under `Etc/`.
 */
function zoneCity(timeZone: string): string | null {
  const parts = timeZone.split("/");
  const place = parts.at(-1);
  if (parts.length < 2 || parts[0] === "Etc" || !place) return null;
  return place.replace(/_/g, " ");
}

/**
 * The event's timezone spelt out for a guest, e.g. "AEDT (Sydney time)". An
 * abbreviation alone means nothing to a guest from elsewhere; the city says
 * whose clock it is. Just the abbreviation for a zone named after no place.
 */
export function timezoneName(event: Pick<EventSummary, "startAt" | "timezone">): string {
  const label = timezoneLabel(event);
  if (!label) return "";
  const city = zoneCity(event.timezone);
  return city ? `${label} (${city} time)` : label;
}

/**
 * Format the start–end time range in `timeZone` (the event's own unless
 * given), e.g. "4:00 pm – 10:00 pm".
 *
 * An event that ends on a later calendar day than it starts — read in that same
 * zone — names both days, "Fri 6:00 pm – Sun 11:00 am", an overnight one
 * included; a week or more apart, the dates too, since a weekday alone would
 * then name two days. `startDay` names the start's day even when the range ends
 * the same day. A missing end (the `""` no-stated-end sentinel) gives the start
 * alone, as does an end whose clock equals the start's on the same day.
 */
export function formatTimeRange(
  event: Pick<EventSummary, "startAt" | "endAt" | "timezone">,
  timeZone: string = event.timezone,
  options: { startDay?: boolean } = {},
): string {
  const start = instant(event.startAt);
  if (!start) return "";
  const startClock = clock(start, timeZone);
  const end = instant(event.endAt);
  const days = end ? daysBetween(dayKey(start, timeZone), dayKey(end, timeZone)) : 0;
  const withDate = days >= 7;
  const startText =
    options.startDay || days > 0
      ? `${dayLabel(start, timeZone, withDate)} ${startClock}`
      : startClock;
  if (!end) return startText;
  const endClock = clock(end, timeZone);
  if (days > 0) return `${startText} – ${dayLabel(end, timeZone, withDate)} ${endClock}`;
  if (endClock === startClock) return startText;
  return `${startText} – ${endClock}`;
}

/**
 * Resolve a safe, always-working "open in maps" URL.
 *
 * Prefers the organiser-supplied `mapsUrl` when it is a valid http(s) link;
 * otherwise derives a Google Maps *search* URL from {@link venueQuery}. Returns
 * null only when neither a usable link nor anything to search for is
 * available, so the caller can hide the affordance rather than render a dead
 * button.
 */
export function resolveMapsUrl(
  event: Pick<EventSummary, "mapsUrl" | "address" | "venueName">,
): string | null {
  const direct = event.mapsUrl?.trim();
  if (direct && isHttpUrl(direct)) return direct;

  const venue = venueQuery(event);
  if (!venue) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue)}`;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve a Google Maps Embed API `place` URL for the event's venue, or null.
 *
 * The Embed API takes free text as its `q` query — no coordinates and no
 * geocoding — so it slots straight onto what cire already stores
 * ({@link venueQuery}: the address, else the venue's name). The result is
 * meant for an `<iframe>` `src`.
 *
 * Returns null (so the caller renders the CSS-card fallback) when:
 *  - no `key` is configured (the var is unset/blank at build time), or
 *  - there is no address or venue name to query.
 *
 * The query is the only interpolated value and is always `encodeURIComponent`-
 * escaped, so organiser-supplied text can never break out of the query string.
 * The key is referrer-restricted at the Google Maps Platform console, which is
 * what makes baking it into static HTML safe; it must never be logged.
 */
export function resolveMapsEmbedUrl(
  event: Pick<EventSummary, "address" | "venueName">,
  key: string | undefined,
): string | null {
  const trimmedKey = key?.trim();
  if (!trimmedKey) return null;

  const venue = venueQuery(event);
  if (!venue) return null;

  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(
    trimmedKey,
  )}&q=${encodeURIComponent(venue)}`;
}

/**
 * The guest's own timezone, from the browser. Null where it cannot be read.
 * Call it after mount: the server renders in its own zone, so reading it
 * during render would make the first client render differ from the HTML.
 */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The event's times on the guest's own clock, e.g. "Fri 10:30 pm – Sat 4:30 am
 * (GMT-8)", always naming the day, since the guest's day can differ from the
 * event's. Null when that clock reads the same as the event's own (a Melbourne
 * guest at a Sydney wedding), for a zone the browser does not know, and for an
 * event with no readable start.
 */
export function guestLocalTime(
  event: Pick<EventSummary, "startAt" | "endAt" | "timezone">,
  guestZone: string,
): string | null {
  const start = instant(event.startAt);
  if (!start) return null;
  try {
    const theirs = formatTimeRange(event, guestZone, { startDay: true });
    const ours = formatTimeRange(event, event.timezone, { startDay: true });
    if (theirs === ours) return null;
    return `${theirs} (${zoneLabel(start, guestZone)})`;
  } catch {
    return null;
  }
}

/** One member of a household, as far as an invitation is concerned. */
type Invitee = Pick<FamilyMember, "firstName" | "lastName" | "eventIds" | "plusOneOf">;

/**
 * Who in the household is invited to this event, when it is not everyone, e.g.
 * "Alex and Sam". Null when every member the couple invited has the event —
 * which is what a guest assumes, so it needs no saying — and when nobody does.
 *
 * Plus-ones never decide it: a plus-one's invitations are its inviter's, so it
 * is invited wherever they are. It is still named, after the members, in the
 * household's order, so the list is everyone who can come. A first name the
 * person shares with anyone in the household — invited here or not — is given
 * with the last name, so the household can tell which of them is asked.
 */
export function invitedNames(members: readonly Invitee[], eventId: string): string | null {
  const invited = invitedMembers(members);
  if (invited.every((m) => m.eventIds.includes(eventId))) return null;
  const here = members.filter((m) => m.eventIds.includes(eventId));
  if (here.length === 0) return null;
  const first = (m: Invitee) => m.firstName.trim();
  const names = here.map((m) =>
    members.filter((other) => first(other) === first(m)).length > 1
      ? `${first(m)} ${m.lastName.trim()}`.trim()
      : first(m),
  );
  // The default list is the long conjunction: "Alex, Sam and Priya".
  return new Intl.ListFormat("en-AU").format(names);
}
