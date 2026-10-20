/**
 * Helpers for the holistic event-details view. Pure, framework-free, and
 * timezone-aware — the modal stays declarative and these stay unit-testable.
 *
 * Cire stores `startAt` / `endAt` as ISO strings (with offset) plus an IANA
 * `timezone`, and a venue `address` + an optional `mapsUrl`. There are NO
 * stored lat/lng coordinates, so every "where" affordance below is derived
 * from `address` / `mapsUrl` alone — no map API key, no network call.
 */
import { invitedMembers } from "./plus-one";
import type { EventSummary, FamilyMember } from "./types";

/** Resolve the canonical venue string from the free-form `address`, or null when unset. */
export function venueLine(event: Pick<EventSummary, "address">): string | null {
  const address = event.address?.trim();
  return address && address.length > 0 ? address : null;
}

/**
 * Format the event's calendar day in its own timezone, e.g. "Friday, 18 September 2026".
 * Reads the wall-clock day in `timezone` so a late-evening event in a +10 zone
 * never rolls back to the previous UTC day.
 */
export function formatEventDay(event: Pick<EventSummary, "startAt" | "timezone">): string {
  const date = new Date(event.startAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: event.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** Format a single instant as a wall-clock time in `timezone`, e.g. "4:00 pm". */
function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** The parts of `date`'s calendar day in `timeZone` this module prints or compares. */
function dayParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(date);
  const part = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // `en-CA` writes the date as YYYY-MM-DD, which parses back as UTC midnight:
  // a day number comparable by subtraction.
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return {
    weekday: String(part.weekday),
    day: String(part.day),
    month: String(part.month),
    ordinal: Date.parse(`${ymd}T00:00:00Z`) / 86_400_000,
  };
}

function parseInstant(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Short timezone label for the event instant, e.g. "AEST" / "GMT+10". */
export function timezoneLabel(event: Pick<EventSummary, "startAt" | "timezone">): string {
  const date = new Date(event.startAt);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: event.timezone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/**
 * The event's timezone spelt out, e.g. "AEST (Sydney time)". The city is the
 * IANA id's last segment; a zone with none to give ("UTC", "Etc/GMT-10") gets
 * the short label alone, since "(UTC time)" says nothing the label didn't.
 */
export function timezoneName(event: Pick<EventSummary, "startAt" | "timezone">): string {
  const label = timezoneLabel(event);
  if (!label) return "";
  const zone = event.timezone;
  if (!zone.includes("/") || zone.startsWith("Etc/")) return label;
  const city = zone.slice(zone.lastIndexOf("/") + 1).replaceAll("_", " ");
  return `${label} (${city} time)`;
}

/**
 * Format the start–end range as a clock reads it in `timeZone` (the event's
 * own by default), comparing calendar days in that same zone:
 *
 *  - one day: "4:00 pm – 10:00 pm", or the start alone when the clocks match;
 *  - ending one to six days later: "Fri 6:00 pm – Sun 11:00 am";
 *  - a week or more: "Fri 13 Nov 6:00 pm – Sat 21 Nov 11:00 am", where a
 *    weekday alone would read as the next one.
 *
 * No end (`endAt: ""`, or unparseable) gives the start alone. `startDay` puts
 * the weekday on a one-day range too, for a line that has no date above it.
 */
export function formatTimeRange(
  event: Pick<EventSummary, "startAt" | "endAt" | "timezone">,
  timeZone: string = event.timezone,
  { startDay = false }: { startDay?: boolean } = {},
): string {
  const start = parseInstant(event.startAt);
  if (!start) return "";
  const startClock = formatClock(start, timeZone);
  const from = dayParts(start, timeZone);
  const end = parseInstant(event.endAt);
  if (!end) return startDay ? `${from.weekday} ${startClock}` : startClock;

  const endClock = formatClock(end, timeZone);
  const to = dayParts(end, timeZone);
  const days = to.ordinal - from.ordinal;
  if (days <= 0) {
    const lead = startDay ? `${from.weekday} ` : "";
    return endClock === startClock ? `${lead}${startClock}` : `${lead}${startClock} – ${endClock}`;
  }
  if (days < 7) return `${from.weekday} ${startClock} – ${to.weekday} ${endClock}`;
  return (
    `${from.weekday} ${from.day} ${from.month} ${startClock} – ` +
    `${to.weekday} ${to.day} ${to.month} ${endClock}`
  );
}

/** The browser's own timezone. The one place the details panel reads it, so a test can fix it. */
export function guestTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The event's times as the guest's own clock reads them, e.g.
 * "Fri 7:00 am – 1:00 pm (BST)", or null when that reads the same as the
 * event's clock (Melbourne for a Sydney wedding), when `zone` is not one Intl
 * knows, or when the start is unparseable. Computed on the device; nothing
 * about the guest's zone leaves it.
 */
export function guestLocalTime(
  event: Pick<EventSummary, "startAt" | "endAt" | "timezone">,
  zone: string,
): string | null {
  // An empty or unknown zone makes Intl throw, and an unparseable start
  // formats as "" on both clocks: both come out null below.
  try {
    const theirs = formatTimeRange(event, zone, { startDay: true });
    const ours = formatTimeRange(event, event.timezone, { startDay: true });
    if (theirs === ours) return null;
    return `${theirs} (${timezoneLabel({ startAt: event.startAt, timezone: zone })})`;
  } catch {
    // RangeError: a zone id this browser's Intl does not recognise.
    return null;
  }
}

/**
 * Who in the household is invited to this event, in words ("Ana, Cy and Di"),
 * or null when there is nothing worth saying: every member the couple invited
 * has it (plus-ones follow their inviter, so they never make a difference), or
 * nobody does. Names come in household order, plus-ones included; a first name
 * two of them share is given with its last name.
 */
export function invitedNames(
  members: ReadonlyArray<Pick<FamilyMember, "firstName" | "lastName" | "eventIds" | "plusOneOf">>,
  eventId: string,
): string | null {
  const has = (m: { eventIds: readonly string[] }) => m.eventIds.includes(eventId);
  if (invitedMembers(members).every(has)) return null;
  const going = members.filter(has);
  if (going.length === 0) return null;
  const count = new Map<string, number>();
  for (const m of going) count.set(m.firstName, (count.get(m.firstName) ?? 0) + 1);
  const names = going.map((m) =>
    (count.get(m.firstName) ?? 0) > 1 ? `${m.firstName} ${m.lastName}` : m.firstName,
  );
  // "Ana, Cy and Di": a conjunction is the default list type.
  return new Intl.ListFormat("en-AU").format(names);
}

/**
 * Resolve a safe, always-working "open in maps" URL.
 *
 * Prefers the organiser-supplied `mapsUrl` when it is a valid http(s) link;
 * otherwise derives a Google Maps *search* URL from the venue `address`. Returns
 * null only when neither a usable link nor an address is available, so the
 * caller can hide the affordance rather than render a dead button.
 */
export function resolveMapsUrl(event: Pick<EventSummary, "mapsUrl" | "address">): string | null {
  const direct = event.mapsUrl?.trim();
  if (direct && isHttpUrl(direct)) return direct;

  const venue = venueLine(event);
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
 * The Embed API takes a free-text address as its `q` query — no coordinates and
 * no geocoding — so it slots straight onto the `address` cire already stores
 * (see `venueLine`). The result is meant for an `<iframe>` `src`.
 *
 * Returns null (so the caller renders the CSS-card fallback) when:
 *  - no `key` is configured (the var is unset/blank at build time), or
 *  - there is no venue address to query.
 *
 * The address is the only interpolated value and is always `encodeURIComponent`-
 * escaped, so organiser-supplied text can never break out of the query string.
 * The key is referrer-restricted at the Google Maps Platform console, which is
 * what makes baking it into static HTML safe; it must never be logged.
 */
export function resolveMapsEmbedUrl(
  event: Pick<EventSummary, "address">,
  key: string | undefined,
): string | null {
  const trimmedKey = key?.trim();
  if (!trimmedKey) return null;

  const venue = venueLine(event);
  if (!venue) return null;

  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(
    trimmedKey,
  )}&q=${encodeURIComponent(venue)}`;
}
