import type { EventSummary } from "./types";

/** Zero-pad a number to a fixed width (default 2). */
function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/**
 * Format a Date as a UTC basic ICS timestamp: YYYYMMDDTHHmmssZ.
 */
function utcBasic(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Format a Date as a local-basic ICS timestamp (no Z, in the given IANA timezone):
 * YYYYMMDDTHHmmss. Uses Intl.DateTimeFormat to extract the wall-clock parts in tz.
 */
function localBasic(d: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // Intl can return "24" for hour12:false at midnight in some engines; normalise.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}${get("month")}${get("day")}T${hour}${get("minute")}${get("second")}`;
}

/**
 * RFC 5545 escaping for SUMMARY / LOCATION / DESCRIPTION text values.
 * Order matters — escape backslash first so we don't double-escape it.
 */
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold a single logical line so no physical line exceeds 75 octets (UTF-8 bytes).
 * Continuation lines start with a single space. CRLF separators between segments.
 *
 * Boundary safety: a multi-byte UTF-8 codepoint must not be split across a
 * fold, otherwise `TextDecoder.decode` emits U+FFFD on each side. We back the
 * cut up to the nearest leading-byte boundary (any byte where the top two bits
 * are not `10`).
 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;

  // Walk the cut back to the start of a UTF-8 codepoint. Continuation bytes
  // are `10xxxxxx` (binary), so a leading byte is anything `& 0xC0 !== 0x80`.
  function safeCut(end: number): number {
    let i = end;
    while (i > 0 && (bytes[i]! & 0xc0) === 0x80) i--;
    return i;
  }

  const segments: Uint8Array[] = [];
  let offset = 0;
  // First segment: up to 75 octets. Subsequent: up to 74 (leading space counts).
  let cut = safeCut(Math.min(offset + 75, bytes.length));
  segments.push(bytes.slice(offset, cut));
  offset = cut;
  while (offset < bytes.length) {
    cut = safeCut(Math.min(offset + 74, bytes.length));
    // safeCut can land at offset if the first byte itself is a continuation
    // (impossible from a valid TextEncoder input, but guard anyway).
    if (cut === offset) cut = Math.min(offset + 74, bytes.length);
    segments.push(bytes.slice(offset, cut));
    offset = cut;
  }
  return segments.map((seg, i) => (i === 0 ? dec.decode(seg) : " " + dec.decode(seg))).join("\r\n");
}

/**
 * Build a Google Calendar "render" URL for the given event.
 *
 * Google's `dates` parameter is UTC basic format only — convert from event.startAt /
 * event.endAt (which are ISO strings with offset) into UTC. `ctz` carries the
 * IANA zone so Google still shows the right wall-clock time to the recipient.
 */
export function googleCalendarUrl(event: EventSummary, siteUrl: string): string {
  const start = utcBasic(new Date(event.startAt));
  const end = utcBasic(new Date(event.endAt));

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.name,
    dates: `${start}/${end}`,
    details: `${event.description}\n\nInvite: ${siteUrl}`,
    location: event.address ?? event.location,
    ctz: event.timezone,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Build an RFC 5545 VCALENDAR/VEVENT blob suitable for download as `.ics`.
 * Generation is fully client-side — we already have every field we need from
 * the claim response, so there is no need for a Worker round-trip.
 */
export function icsBlob(event: EventSummary, siteUrl: string): Blob {
  const tz = event.timezone;
  const dtStart = localBasic(new Date(event.startAt), tz);
  const dtEnd = localBasic(new Date(event.endAt), tz);
  const dtStamp = utcBasic(new Date());
  const location = event.address ?? event.location;

  const rawLines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//cire//invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@cire.invite`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;TZID=${tz}:${dtStart}`,
    `DTEND;TZID=${tz}:${dtEnd}`,
    `SUMMARY:${escapeIcsText(event.name)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `DESCRIPTION:${escapeIcsText(`${event.description}\n\nInvite: ${siteUrl}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const text = rawLines.map(foldLine).join("\r\n") + "\r\n";
  return new Blob([text], { type: "text/calendar;charset=utf-8" });
}

/**
 * Wrap `icsBlob` with `URL.createObjectURL`. Caller is responsible for
 * `URL.revokeObjectURL` on cleanup to release the underlying memory.
 */
export function icsObjectUrl(event: EventSummary, siteUrl: string): string {
  return URL.createObjectURL(icsBlob(event, siteUrl));
}
