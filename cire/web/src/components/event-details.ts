import type { EventSummary } from "./types";

/**
 * Helpers for the holistic event-details view. Pure, framework-free, and
 * timezone-aware — the modal stays declarative and these stay unit-testable.
 *
 * Cire stores `startAt` / `endAt` as ISO strings (with offset) plus an IANA
 * `timezone`, and a venue `address` + an optional `mapsUrl`. There are NO
 * stored lat/lng coordinates, so every "where" affordance below is derived
 * from `address` / `mapsUrl` alone — no map API key, no network call.
 */

/** Resolve the canonical venue string, preferring `address` over the deprecated `location`. */
export function venueLine(event: Pick<EventSummary, "address" | "location">): string | null {
  const address = event.address?.trim();
  if (address) return address;
  const location = event.location?.trim();
  return location && location.length > 0 ? location : null;
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
function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
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
 * Format the start–end time range in the event's timezone, e.g.
 * "4:00 pm – 10:00 pm". Falls back to just the start when the two clock labels
 * collapse to the same value (a zero-length or mis-entered window).
 */
export function formatTimeRange(
  event: Pick<EventSummary, "startAt" | "endAt" | "timezone">,
): string {
  const start = formatClock(event.startAt, event.timezone);
  const end = formatClock(event.endAt, event.timezone);
  if (!start) return "";
  if (!end || end === start) return start;
  return `${start} – ${end}`;
}

/**
 * Resolve a safe, always-working "open in maps" URL.
 *
 * Prefers the organiser-supplied `mapsUrl` when it is a valid http(s) link;
 * otherwise derives a Google Maps *search* URL from the venue `address`. Returns
 * null only when neither a usable link nor an address is available, so the
 * caller can hide the affordance rather than render a dead button.
 */
export function resolveMapsUrl(
  event: Pick<EventSummary, "mapsUrl" | "address" | "location">,
): string | null {
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
  event: Pick<EventSummary, "address" | "location">,
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
