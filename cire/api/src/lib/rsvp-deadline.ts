/**
 * The RSVP deadline — the "kindly respond by" date an organiser sets on their
 * wedding, past which the guest invite locks (no more RSVP writes, read-only
 * render).
 *
 * A DATE IS NOT AN INSTANT, and this module is the one place that turns one
 * into the other. Everything else — the guest write gate, the claim payload,
 * the organiser settings write — goes through `resolveRsvpDeadline`, so the
 * server's 403 and the guest site's "closed" banner can never disagree about
 * when the door shut.
 *
 * The contract:
 *  - `date` is date-only ISO (`YYYY-MM-DD`) and INCLUSIVE — a deadline of
 *    2026-09-01 lets a guest reply at 23:59 on the 1st.
 *  - `timezone` is the IANA zone that day is measured in (stamped from the
 *    organiser's own zone when they pick the date). NULL/unknown ⇒ UTC, so
 *    there is always exactly one answer.
 *  - The lock instant is the last millisecond of that local day
 *    (`23:59:59.999`); `closed` means `now > that instant`.
 */

/** Zone assumed when a wedding carries a deadline date but no zone. */
export const DEFAULT_RSVP_DEADLINE_TIMEZONE = "UTC";

/** Date-only ISO shape shared with the settings schema's calendar-date filter. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonical form of an IANA zone identifier, or `null` if this runtime's ICU
 * data can't resolve it. `Intl` accepts more than the settings schema means by
 * "IANA identifier" — `"+05:30"`, `"utc"` and `"AUSTRALIA/sydney"` all construct
 * — so a bare try/catch would let three problems through (S-L2):
 *  - a FIXED-OFFSET zone never applies DST, so a deadline stored as `"+05:30"`
 *    silently drifts an hour against the organiser's real zone across a
 *    transition;
 *  - the same zone could be stored under many spellings, so equal deadlines
 *    wouldn't compare equal;
 *  - and only canonical values ever reaching the hot path is what keeps
 *    `offsetFormatter`'s cache bounded (see below).
 * Resolving through `resolvedOptions()` collapses the aliases and casing;
 * rejecting a leading `+`/`-` drops the offset forms.
 *
 * Deliberately NOT cached: it takes organiser-supplied strings at the settings
 * boundary, and caching by INPUT would let case variants of one real zone grow
 * the map without bound. It runs on a rare, owner-gated write, not a hot path.
 */
export function canonicalTimeZone(timezone: string): string | null {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
    return /^[+-]/.test(resolved) ? null : resolved;
  } catch {
    return null;
  }
}

/** Does this runtime resolve `timezone` to a real (non-offset) IANA zone? */
export function isValidTimeZone(timezone: string): boolean {
  return canonicalTimeZone(timezone) !== null;
}

/**
 * Offset formatters, keyed by zone. Construction is the expensive half of ICU
 * date handling (~75µs) while `formatToParts` on an existing formatter is
 * cheap, and this module runs on the two busiest guest endpoints — every claim
 * and every RSVP submit — so building one per call burned ~14× the CPU the work
 * needs, against a 10ms Workers budget (P-W1).
 *
 * ONLY SUCCESSFUL LOOKUPS ARE CACHED, which is what bounds the map: a miss
 * costs a throwaway construction and stores nothing, so junk input can't grow
 * it, and the keys that do land are the ~600 real IANA identifiers. Formatters
 * are stateless with respect to the instant (`formatToParts` takes the date as
 * an argument), so one instance is safely shared across calls and across both
 * DST-resolution passes.
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timezone: string): Intl.DateTimeFormat | null {
  const cached = offsetFormatters.get(timezone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timezone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/**
 * The zone's UTC offset (ms) at a given instant — i.e. `local wall clock - UTC`.
 * Derived by formatting the instant into the zone and reading the wall-clock
 * fields back, which is the only offset source available without a tz library.
 */
function zoneOffsetMs(instant: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(new Date(instant));

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  // `hour12: false` renders midnight as hour 24 in some ICU versions — the same
  // instant, one day earlier in wall-clock terms, so normalise it to 0 (Date.UTC
  // would otherwise roll the day forward and report a 24h offset).
  const hour = field("hour") % 24;
  // `formatToParts` has no millisecond part, so carry the instant's own ms
  // across — otherwise the reconstructed wall clock is truncated to the second
  // and the "offset" absorbs up to 999ms of the instant it was measured at.
  const milliseconds = ((instant % 1000) + 1000) % 1000;
  const wallClock = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    hour,
    field("minute"),
    field("second"),
    milliseconds,
  );
  return wallClock - instant;
}

/**
 * Epoch ms of `YYYY-MM-DDT23:59:59.999` **in `timezone`**.
 *
 * Two passes: the first offset is read at the UTC-interpreted instant, which is
 * up to a day away from the real one and so can sample the wrong side of a DST
 * transition; re-reading the offset at the corrected instant settles it. (A
 * third pass can never differ — the correction after pass two is under an hour
 * and end-of-day is never within an hour of a transition that matters here.)
 *
 * On the two ambiguous local times DST creates, this lands on the later/earlier
 * side by however the runtime resolves the sampled offset — a sub-hour wobble
 * on the last millisecond of a day, which no RSVP deadline cares about.
 */
export function rsvpDeadlineEndsAt(date: string, timezone: string): number {
  // Resolve the formatter ONCE and reuse it across both passes. A zone the
  // runtime can't resolve degrades to UTC here rather than throwing, matching
  // `resolveRsvpDeadline`'s fail-open stance (UTC is always resolvable, so the
  // second lookup cannot be null).
  const formatter = offsetFormatter(timezone) ?? offsetFormatter(DEFAULT_RSVP_DEADLINE_TIMEZONE)!;
  const asUtc = Date.parse(`${date}T23:59:59.999Z`);
  const firstPass = asUtc - zoneOffsetMs(asUtc, formatter);
  return asUtc - zoneOffsetMs(firstPass, formatter);
}

/**
 * Is this a real calendar date in `YYYY-MM-DD`? The pattern alone admits
 * impossible days (2026-02-31), so round-trip through `Date` and require the
 * same day back — engine-lenient parses that silently roll over are rejected.
 */
function isCalendarDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

/** The zone to measure a stored deadline in — the stored one when this runtime
 *  knows it, UTC otherwise (fail open; see `resolveRsvpDeadline`). */
function effectiveZone(timezone: string | null | undefined): string {
  return timezone && offsetFormatter(timezone) !== null ? timezone : DEFAULT_RSVP_DEADLINE_TIMEZONE;
}

/** A wedding's deadline, resolved to one instant and one open/closed answer. */
export interface ResolvedRsvpDeadline {
  /** Date-only ISO (`YYYY-MM-DD`) exactly as stored. */
  date: string;
  /** The zone actually applied — the stored one, or UTC when it was absent. */
  timezone: string;
  /** ISO instant the invite locks: the last millisecond of `date` in `timezone`. */
  closesAt: string;
  /** `now` is past `closesAt`. */
  closed: boolean;
}

/**
 * Resolve a wedding's stored deadline columns. `null` (no date, or a
 * malformed one) means NO deadline — RSVPs stay open forever, which is what
 * every wedding created before this feature reads as.
 *
 * A stored date that isn't a real calendar date, or a zone this runtime can't
 * resolve, degrades rather than throws: the write path validates both, so
 * reaching either branch means data written by an older/other client. Failing
 * open on a bad date (no deadline) and on UTC for a bad zone keeps a data
 * problem from locking guests out of an invite.
 */
export function resolveRsvpDeadline(
  date: string | null | undefined,
  timezone: string | null | undefined,
  now: Date,
): ResolvedRsvpDeadline | null {
  if (!date || !isCalendarDate(date)) return null;

  const zone = effectiveZone(timezone);
  const endsAt = rsvpDeadlineEndsAt(date, zone);

  return {
    date,
    timezone: zone,
    closesAt: new Date(endsAt).toISOString(),
    closed: now.getTime() > endsAt,
  };
}

/**
 * The write gates' predicate: are RSVPs closed right now?
 *
 * Computes the instant directly instead of going through
 * `resolveRsvpDeadline`, whose `closesAt` string this caller never reads — a
 * `Date` allocation and an ISO serialisation per RSVP submit, for nothing
 * (P-I1). Both still route through the same `rsvpDeadlineEndsAt`, so the
 * server's 403 and the claim payload's `closesAt` cannot drift apart.
 */
export function isRsvpClosed(
  date: string | null | undefined,
  timezone: string | null | undefined,
  now: Date,
): boolean {
  if (!date || !isCalendarDate(date)) return false;
  return now.getTime() > rsvpDeadlineEndsAt(date, effectiveZone(timezone));
}
