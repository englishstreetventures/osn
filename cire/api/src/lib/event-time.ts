/**
 * An event's time is a WALL CLOCK plus an IANA zone — never a UTC offset.
 *
 * That is the model the organiser portal's drawer has used since the offset
 * picker was removed: an offset is a fact ABOUT a zone on a particular date, not
 * a property of the event, so "+10:00" typed for a Sydney wedding in November is
 * simply wrong and nothing catches it. This module is the SHEET path's half of
 * the same rule — the uploaded `Start` / `End` cells state local time, the
 * `Timezone` column says which zone that clock is on, and the offset the stored
 * timestamp carries is DERIVED here (DST-correctly, for that event's own date).
 *
 * Why the stored value keeps an offset at all: `events.start_at` / `end_at` are
 * read as INSTANTS by the guest site (`new Date(startAt)` for the day/time
 * render and the ICS + Google Calendar links) and sorted as instants by
 * `lib/event-order.ts`. An offsetless string parses against the VIEWER's zone in
 * every one of those places, so the offset stays as an internal, always-derived
 * detail of the storage format. It is not something an organiser types or sees:
 * the CSV template, the CSV parser, the exports and the editor all speak wall
 * clock + zone.
 *
 * The client twin of {@link zoneOffsetAt} is `cire/host/src/lib/timezones.ts`
 * (the drawer stamps the same offset onto an edited event). Same two-pass DST
 * resolution, same answers — duplicated only because this module is server-side
 * and the organiser bundle cannot import from `@cire/api`.
 */

import { canonicalTimeZone } from "./rsvp-deadline";

/**
 * A Start/End cell: `YYYY-MM-DDTHH:MM`, optionally with seconds and a fraction,
 * optionally with a trailing offset or `Z`. The offset group is matched only so
 * it can be DISCARDED — see {@link parseWallTime}.
 */
const WALL_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** The local date + time a Start/End cell names. */
export interface WallTime {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`. */
  time: string;
  /** `SS` — "00" when the cell gave no seconds. */
  seconds: string;
}

/**
 * Split a Start/End cell into the local date + time it names, or null when it
 * isn't a timestamp at all.
 *
 * ANY OFFSET IN THE CELL IS IGNORED, including a `Z`. The Timezone column is
 * authoritative — that is the whole point of asking for a zone — so a cell that
 * says `15:00+10:00` for a Sydney event means three o'clock in Sydney, and the
 * `+10:00` (wrong for November) is dropped rather than believed. The alternative
 * — resolving the offset to an instant and re-expressing it in the zone — would
 * quietly move the ceremony to 4pm, which is exactly the class of bug the
 * wall-clock model exists to end.
 *
 * Stricter than a `Date.parse` round-trip on purpose: everything downstream
 * (the retention sweep's lexical `YYYY-MM-DD` comparison, the offset stamp
 * below) assumes the zero-padded shape, so a value `Date` happens to accept but
 * this cannot re-emit is rejected at the front door instead of stored.
 */
export function parseWallTime(value: string): WallTime | null {
  const m = WALL_TIME_RE.exec(value.trim());
  if (!m) return null;
  const [, date, time, seconds = "00"] = m;
  // The pattern alone admits impossible clock readings (`2026-13-40T99:99`), so
  // round-trip the wall fields through the strict ISO parser. Read as UTC purely
  // to get a zone-independent verdict — this decides whether the reading EXISTS,
  // not which instant it names.
  if (Number.isNaN(Date.parse(`${date}T${time}:${seconds}Z`))) return null;
  return { date: date!, time: time!, seconds };
}

/**
 * `longOffset` formatters, cached by CANONICAL zone. Construction is the
 * expensive half of ICU date handling (~75µs) and an events import stamps two
 * timestamps per row, so building one per call would burn most of a Workers CPU
 * budget on a large schedule. Only canonical zones are ever used as keys, which
 * is what bounds the map — `Intl` resolves unboundedly many spellings of one
 * zone, so caching by raw input would let a hostile sheet grow it.
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(canonical: string): Intl.DateTimeFormat | null {
  const cached = offsetFormatters.get(canonical);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: canonical,
      timeZoneName: "longOffset",
    });
    offsetFormatters.set(canonical, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** Minutes east of UTC that `canonical` is on at the given INSTANT, or null when
 *  the runtime won't name an offset. `longOffset` renders "GMT+11:00", "GMT-05:00"
 *  or a bare "GMT" at zero; an older ICU that only manages "GMT+11" parses too
 *  (the minutes group is optional). */
function offsetMinutesAt(canonical: string, at: Date): number | null {
  const name = offsetFormatter(canonical)
    ?.formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  if (!name) return null;
  if (name === "GMT" || name === "UTC") return 0;
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** `±HH:MM` for a count of minutes east of UTC. Zero renders `+00:00`, not `Z` —
 *  the canonical stored shape spells the offset out, and every reader accepts
 *  both. */
function formatOffsetMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * `canonicalTimeZone`, memoized per raw input string — the events-import loop
 * (`services/spreadsheet.ts`) resolves the SAME zone up to three times per row
 * (once to validate the `Timezone` cell, twice more inside the Start/End
 * `stampEventOffset` calls), and `canonicalTimeZone` itself is deliberately
 * uncached: its other call site is the RSVP-deadline settings write, a rare
 * one-shot lookup where a cache would only grow a map for nothing. An events
 * sheet has no such luxury — `MAX_ROWS` rows at three fresh
 * `Intl.DateTimeFormat` constructions apiece (~75µs each) is real CPU against a
 * Workers request budget, for a value that is usually the SAME zone on every
 * row of one wedding's schedule.
 *
 * ONLY SUCCESSFUL resolutions are cached, matching `offsetFormatters` below: a
 * miss costs one throwaway construction and stores nothing, so a hostile sheet
 * of near-misses can't grow the map, and the keys that do land are bounded by
 * the real IANA spellings (+ casing variants) a spreadsheet app might actually
 * produce.
 */
const canonicalZoneCache = new Map<string, string>();

function resolveTimeZone(zone: string): string | null {
  const cached = canonicalZoneCache.get(zone);
  if (cached) return cached;
  const canonical = canonicalTimeZone(zone);
  if (canonical !== null) canonicalZoneCache.set(zone, canonical);
  return canonical;
}

/** Is `zone` a real IANA zone this runtime can resolve? The memoized twin of
 *  `lib/rsvp-deadline.ts`'s `isValidTimeZone`, for this module's hot import
 *  path — see {@link resolveTimeZone}. Also rejects the fixed-offset spellings
 *  `Intl` accepts ("+10:00", "UTC+10"), which never apply DST. */
export function isKnownTimeZone(zone: string): boolean {
  return resolveTimeZone(zone) !== null;
}

/**
 * The UTC offset (`+HH:MM` / `-HH:MM`) that `zone` is on for a given WALL-CLOCK
 * date + time — the answer to "the ceremony is at 3pm in Sydney on 14 November;
 * what offset does that timestamp carry?". Null when the date/time is malformed
 * or `zone` is not a real IANA zone (INCLUDING a fixed-offset pseudo-zone like
 * `"+10:00"`, which would answer with a DST-blind constant and reinstate the bug
 * this whole model exists to end).
 *
 * Two passes, because the input is a wall clock and the zone's offset is what
 * we're trying to find: read the offset at the naive UTC reading of that wall
 * time, subtract it to get a much better instant, then read the offset THERE.
 * The second reading is correct on every day except the couple of hours around a
 * DST transition, where the wall time is ambiguous or non-existent and any
 * answer is a choice. Both choices here match `Temporal`'s `compatible`
 * disambiguation:
 *  - a REPEATED hour resolves to its second occurrence (the later offset);
 *  - a NON-EXISTENT hour is shifted forward, so the wall clock the organiser
 *    typed denotes a real instant on the far side of the gap rather than being
 *    rejected or landing an hour out.
 */
export function zoneOffsetAt(zone: string, date: string, time: string): string | null {
  const canonical = resolveTimeZone(zone);
  if (canonical === null) return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{2}):(\d{2})/.exec(time.trim());
  if (!d || !t) return null;
  const naive = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (Number.isNaN(naive)) return null;
  const first = offsetMinutesAt(canonical, new Date(naive));
  if (first === null) return null;
  const second = offsetMinutesAt(canonical, new Date(naive - first * 60_000));
  return formatOffsetMinutes(second ?? first);
}

/**
 * Stamp a Start/End cell with the offset its ZONE is on for that wall clock,
 * producing the canonical stored shape `YYYY-MM-DDTHH:MM:SS±HH:MM`.
 *
 * Seconds are preserved when the cell gave them (so a full-fidelity export →
 * re-import round trip is byte-stable) and default to `:00` otherwise, matching
 * what the editor's drawer emits.
 *
 * A blank value passes straight through — `endAt: ""` is the "no stated end"
 * sentinel, not a timestamp. A value that isn't a timestamp, or a zone this
 * runtime can't resolve, also passes through untouched: the callers validate
 * both first, so reaching either branch means someone bypassed the front door,
 * and mangling the value would be worse than storing it as given.
 */
export function stampEventOffset(value: string, zone: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const wall = parseWallTime(trimmed);
  if (wall === null) return trimmed;
  const offset = zoneOffsetAt(zone, wall.date, wall.time);
  if (offset === null) return trimmed;
  return `${wall.date}T${wall.time}:${wall.seconds}${offset}`;
}

/**
 * The organiser-facing spelling of a stored timestamp: the wall clock, with the
 * derived offset stripped back off (`2026-11-14T15:00:00+11:00` →
 * `2026-11-14T15:00`).
 *
 * This is what every CSV export writes into a `Start` / `End` cell, so an export
 * → edit → re-import round trip speaks the same wall-clock + zone language the
 * template and the editor do, and {@link stampEventOffset} puts the offset back.
 * Seconds are dropped when they're `:00` (they always are, in practice) and kept
 * otherwise, so no information is lost. A value that isn't a timestamp is
 * returned verbatim — an export must show what is actually stored.
 */
export function formatWallTime(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const wall = parseWallTime(trimmed);
  if (wall === null) return trimmed;
  return wall.seconds === "00"
    ? `${wall.date}T${wall.time}`
    : `${wall.date}T${wall.time}:${wall.seconds}`;
}
