import type { Event } from "@pulse/db/schema";

/**
 * RFC 5545 §3.1 line folding: no line may exceed 75 **octets**, and each
 * continuation begins with a single space.
 *
 * The limit is octets, so the width of a character is its UTF-8 length — one
 * emoji is four. Folding on `String.length` counts UTF-16 code units, which
 * both lets a line past the limit and can slice through a surrogate pair,
 * emitting invalid UTF-8 into the file. Iterating with `for...of` walks code
 * points, so a break never lands inside a character.
 */
const encoder = new TextEncoder();

function fold(line: string): string {
  const limit = 75;
  let result = "";
  let octets = 0;
  for (const character of line) {
    const width = encoder.encode(character).length;
    if (octets + width > limit) {
      result += "\r\n ";
      octets = 1;
    }
    result += character;
    octets += width;
  }
  return result;
}

/**
 * TEXT escaping per RFC 5545 §3.3.11 — backslash, semicolon, comma and
 * newline, and nothing else. A lone carriage return is dropped rather than
 * escaped, or it would survive into the output as a stray line break.
 *
 * Not for GEO: that is a structured value whose semicolon separates the pair
 * (§3.8.1.6), so escaping it would break the property.
 */
function escape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function formatDate(date: Date): string {
  // ICS "DATE-TIME" in UTC: 20260415T180000Z
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

/**
 * Builds an RFC 5545 VEVENT wrapped in VCALENDAR for the given event.
 * Callers return the string as `text/calendar; charset=utf-8`.
 *
 * An event with no `endTime` gets no `DTEND`. §3.6.1 allows that, and it says
 * what the row says: the start is known and the end is not. Inventing a
 * duration would put a finish time the host never chose into a guest's
 * calendar, where it looks like fact.
 *
 * The Swift client builds the same document locally in
 * `shared/swift/OSNShared/Sources/PulseFeature/PulseCalendarInvite.swift` —
 * it already holds the event, so it needs no round-trip and works offline.
 * The two must stay in step; the UID spelling in particular, or the same
 * event saved from web and from iOS becomes two entries in one calendar.
 */
export function buildIcs(event: Event): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    // §3.7.3: `-//` marks a product id that isn't in the IANA registry.
    "PRODID:-//Pulse//Pulse Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    // Uniqueness comes from the event id, which is already unique across
    // Pulse. No `uid@host` spelling: Pulse has no public event host to name,
    // and a made-up one would be a lie in a field meant to be stable forever.
    `UID:pulse-event-${event.id}`,
    `DTSTAMP:${formatDate(new Date())}`,
    `DTSTART:${formatDate(event.startTime)}`,
  ];
  if (event.endTime) lines.push(`DTEND:${formatDate(event.endTime)}`);
  lines.push(`SUMMARY:${escape(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escape(event.description)}`);
  const locationParts = [event.venue, event.location].filter(Boolean).join(", ");
  if (locationParts) lines.push(`LOCATION:${escape(locationParts)}`);
  if (event.latitude != null && event.longitude != null) {
    lines.push(`GEO:${event.latitude};${event.longitude}`);
  }
  if (event.category) lines.push(`CATEGORIES:${escape(event.category)}`);
  lines.push(`STATUS:${event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 mandates CRLF line endings.
  return lines.map(fold).join("\r\n") + "\r\n";
}
