// IANA timezone helpers, shared by the two places the portal asks an organiser
// "which zone is this in?" — the settings panel's RSVP-by deadline and the
// events editor's per-event zone.
//
// The events editor used to ask for a raw UTC offset from a fixed ten-item list
// alongside a free-text IANA name, which is two ways of saying the same thing
// and one of them is a trap: an offset is a fact ABOUT a zone on a particular
// date, not a property of the event, so "+10:00" typed for a Sydney wedding in
// November is simply wrong and nothing catches it. The zone is now the only
// thing an organiser picks, and {@link zoneOffset} derives the offset from it —
// DST-correctly, for that event's own date.

/**
 * Resolve a zone to its canonical IANA spelling, or null when this runtime's tz
 * data can't take it. A client-side twin of `canonicalTimeZone` in
 * `cire/api/src/lib/rsvp-deadline.ts` — same rules, same reasons (S-L2 there,
 * S-L1 here), duplicated only because that module is server-side Effect code.
 *
 * `Intl` accepts considerably more than "an IANA identifier": `"+05:30"`,
 * `"utc"` and `"AUSTRALIA/sydney"` all construct successfully. Waving those
 * through costs three things:
 *  - a FIXED-OFFSET zone never applies DST, so `zoneOffset("+10:00", …)` would
 *    return a DST-blind `+10:00` all year — silently reinstating, for imported
 *    data, the exact bug that removing the offset picker was meant to end;
 *  - one real zone under many spellings compares unequal to itself;
 *  - and it is what keeps the formatter caches below BOUNDED. They key on the
 *    canonical form precisely because there are unboundedly many spellings of
 *    a zone that `Intl` will happily resolve, and `event.timezone` is not
 *    canonicalised anywhere upstream (the CSV parser checks non-blank; the
 *    JSON front door checks nothing).
 *
 * Deliberately NOT cached itself: it takes arbitrary strings, so caching by
 * INPUT would reintroduce the unbounded growth it exists to prevent.
 */
export function canonicalTimeZone(zone: string): string | null {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions()
      .timeZone;
    return /^[+-]/.test(resolved) ? null : resolved;
  } catch {
    return null;
  }
}

/** The organiser's own zone, used to seed a new event / stamp a deadline they
 *  have just picked. A browser that won't name its zone (ancient/locked-down)
 *  falls back to UTC — the same default the API applies to a zone-less value.
 *  Resolved once: constructing a formatter costs ~70µs and the browser's zone
 *  cannot change within a page lifetime. */
let ownZone: string | null = null;

export function browserTimeZone(): string {
  if (ownZone !== null) return ownZone;
  try {
    ownZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    ownZone = "UTC";
  }
  return ownZone;
}

/** Zone-name formatters, cached by CANONICAL zone (P-I3). Construction is the
 *  expensive part (~187µs, vs ~2µs to reuse one). Keyed on the canonical form,
 *  so neither an unresolvable zone nor an alternate spelling of a real one can
 *  grow the map — see {@link canonicalTimeZone}. */
const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneNameFormatter(canonical: string): Intl.DateTimeFormat | null {
  const cached = zoneNameFormatters.get(canonical);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-AU", {
      timeZone: canonical,
      timeZoneName: "short",
    });
    zoneNameFormatters.set(canonical, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** "Australia/Sydney" → "Australia/Sydney (AEST)" where the runtime can name
 *  the abbreviation, so the hint says something an organiser recognises. A zone
 *  this runtime can't resolve is returned verbatim — the hint still names what
 *  is stored, which is what an organiser looking at an imported value needs. */
export function describeTimeZone(zone: string, on: string | null): string {
  const at = on ? new Date(`${on}T12:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) return zone;
  const canonical = canonicalTimeZone(zone);
  if (canonical === null) return zone;
  const short = zoneNameFormatter(canonical)
    ?.formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return short && short !== zone ? `${zone} (${short})` : zone;
}

// ── Offsets ──────────────────────────────────────────────────────────────────

/** Same cache-by-zone shape as the abbreviation formatters above, for the
 *  `longOffset` ("GMT+11:00") style. Separate map: a formatter carries its
 *  `timeZoneName` option, so the two styles can't share one instance. */
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

/** Minutes east of UTC that `zone` is on at the given INSTANT, or null when the
 *  runtime can't resolve the zone. `longOffset` renders "GMT+11:00", "GMT-05:00"
 *  or a bare "GMT" at zero; an older runtime that only manages "GMT+11" parses
 *  too (the minutes group is optional). */
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

/** `±HH:MM` for a count of minutes east of UTC. Zero renders `+00:00` (not
 *  `Z`) — the events editor's canonical Start/End shape spells the offset out,
 *  and `isIsoTimestamp` accepts both. */
function formatOffsetMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * The UTC offset (`+HH:MM` / `-HH:MM`) that `zone` is on for the WALL-CLOCK
 * `date` (`YYYY-MM-DD`) + `time` (`HH:MM`) given — the answer to "the ceremony
 * is at 3pm in Sydney on 14 November; what offset does that timestamp carry?".
 * Returns null when the date/time is incomplete, or when the zone is not a real
 * IANA zone — INCLUDING a fixed-offset pseudo-zone like `"+10:00"`, which would
 * otherwise answer with a DST-blind constant and reinstate the very bug the
 * offset picker's removal was meant to end. The caller keeps whatever offset
 * the stored value already had in that case.
 *
 * Two passes, because the input is a wall-clock time and the zone's offset is
 * what we're trying to find: read the offset at the naive UTC reading of that
 * wall time, subtract it to get a much better instant, then read the offset
 * THERE. The second reading is the correct one on every day except the couple
 * of hours around a DST transition, where the wall time is ambiguous or
 * non-existent and any answer is a choice. Both choices here match what
 * `Temporal`'s `compatible` disambiguation picks:
 *  - a REPEATED hour resolves to its second occurrence (the later offset);
 *  - a NON-EXISTENT hour is shifted forward — the offset returned is the
 *    pre-transition one, which is what makes the wall clock the organiser typed
 *    denote a real instant on the far side of the gap, rather than being
 *    rejected or landing an hour out.
 * Both are pinned in `timezones.test.ts`.
 */
export function zoneOffset(zone: string, date: string, time: string): string | null {
  const canonical = canonicalTimeZone(zone);
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

// ── The dropdown's option list ───────────────────────────────────────────────

/**
 * The zones offered when the runtime can't enumerate its own tz database
 * (`Intl.supportedValuesOf` is ES2022; every browser we target has it, but a
 * dropdown with no options would be a dead end, so this is the floor). Broad
 * rather than Australia-only: the portal is not a single-wedding product.
 */
const FALLBACK_ZONES = [
  "Pacific/Auckland",
  "Australia/Sydney",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Perth",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
] as const;

/** Lazily-resolved tz database. Deliberately not computed at module scope: it
 *  is several hundred entries, and a portal session that never opens an event
 *  drawer should never pay for it. */
let supportedZones: Set<string> | null = null;

function allZones(): Set<string> {
  if (supportedZones) return supportedZones;
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  let zones: string[] = [];
  try {
    zones = supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  supportedZones = new Set(zones.length > 0 ? zones : FALLBACK_ZONES);
  return supportedZones;
}

/** One `<optgroup>` of the timezone dropdown. */
export interface TimeZoneGroup {
  label: string;
  zones: string[];
}

/** Zones whose id carries no "Region/" prefix (`UTC`, `GMT`) — grouped under a
 *  name of their own rather than dropped or filed under an empty heading. */
const UNGROUPED_LABEL = "UTC";

/** The grouped list, built once. Held so {@link timeZoneGroups} can return the
 *  SAME array identity on every call for a known zone — a `<For>` reconciles by
 *  item reference, so a freshly-allocated list of freshly-allocated groups made
 *  every zone change tear down and rebuild ~900 `<optgroup>`/`<option>` nodes
 *  (P-W1). The content never depends on the selection, so there is nothing to
 *  rebuild; and replacing every `<option>` under a `<select>` is also how an
 *  element loses the selection it was just given. */
let groupedZones: TimeZoneGroup[] | null = null;

function allGroups(): TimeZoneGroup[] {
  if (groupedZones) return groupedZones;
  const groups = new Map<string, string[]>();
  for (const zone of allZones()) {
    const slash = zone.indexOf("/");
    const label = slash === -1 ? UNGROUPED_LABEL : zone.slice(0, slash).replaceAll("_", " ");
    const list = groups.get(label);
    if (list) list.push(zone);
    else groups.set(label, [zone]);
  }
  groupedZones = Array.from(groups, ([label, list]) => ({
    label,
    zones: list.toSorted((a, b) => a.localeCompare(b)),
  })).toSorted((a, b) => a.label.localeCompare(b.label));
  return groupedZones;
}

/**
 * The dropdown's options, grouped by region so a several-hundred-entry list
 * stays navigable. `current` (the value already on the record) is always
 * present even when the runtime doesn't know it — an imported wedding may carry
 * a zone this browser's tz database has since renamed, and a `<select>` whose
 * value isn't in its options silently shows the FIRST option instead, which
 * would look like the portal quietly moved the wedding to another continent.
 * It leads the list, under a "Current" heading, when it isn't a known zone.
 *
 * A BLANK current value is not handled here, deliberately: there is no zone to
 * list, and inventing one would be the same lie in the other direction. The
 * caller renders an explicit empty option instead — see `EventsEditor`.
 */
export function timeZoneGroups(current?: string | null): TimeZoneGroup[] {
  const ordered = allGroups();
  const value = current?.trim();
  if (value && !allZones().has(value)) {
    return [{ label: "Current", zones: [value] }, ...ordered];
  }
  return ordered;
}
