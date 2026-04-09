import type { Event } from "@pulse/db/schema";

/**
 * RFC 5545 line folding — lines longer than 75 octets must be split and
 * the continuation prefixed with a single space. Simple implementation —
 * splits on character count, not octets, which is close enough for the
 * ASCII-dominant fields we emit.
 */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += 74) {
    chunks.push(i === 0 ? line.slice(i, i + 75) : " " + line.slice(i, i + 74));
  }
  return chunks.join("\r\n");
}

function escape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatDate(date: Date): string {
  // ICS "DATE-TIME" in UTC: 20260415T180000Z
  const pad = (n: number) => String(n).padStart(2, "0");
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
 * End time defaults to start + 2 hours when the event has no explicit
 * endTime (matches how the app renders the card for open-ended events).
 */
export function buildIcs(event: Event): string {
  const dtStart = formatDate(event.startTime);
  const dtEnd = formatDate(
    event.endTime ?? new Date(event.startTime.getTime() + 2 * 60 * 60 * 1000),
  );
  const now = formatDate(new Date());
  const uid = `${event.id}@pulse`;
  const summary = escape(event.title);
  const description = event.description ? escape(event.description) : "";
  const locationParts = [event.venue, event.location].filter(Boolean).join(", ");
  const location = locationParts ? escape(locationParts) : "";

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pulse//Pulse Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    fold(`SUMMARY:${summary}`),
  ];
  if (description) lines.push(fold(`DESCRIPTION:${description}`));
  if (location) lines.push(fold(`LOCATION:${location}`));
  if (event.latitude != null && event.longitude != null) {
    lines.push(`GEO:${event.latitude};${event.longitude}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 mandates CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
