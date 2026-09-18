/**
 * Guest-side rendering of the wedding's RSVP deadline.
 *
 * The API does the deciding: it resolves the organiser's date + zone into
 * `closesAt` (one instant) and a `closed` verdict, and it re-checks on every
 * write (403 `rsvp_closed`). These helpers only present that, plus one thing
 * the server can't do — re-derive `closed` as the clock moves, since a guest
 * can sit on a claimed invite for hours and the payload was computed once.
 */
import type { RsvpDeadline } from "./types";

/**
 * DOM id of the events-section deadline notice. Shared by both design packs so
 * each card's closed Respond button can point `aria-describedby` at it and
 * announce WHEN RSVPs shut, not just that they did. Exactly one notice
 * renders per page, so a fixed id is safe — and keeping it here stops the two
 * packs and `EventCard` drifting onto three different strings, which would fail
 * silently (a dangling `aria-describedby` is simply ignored).
 */
export const RSVP_NOTICE_ID = "rsvp-deadline-notice";

/**
 * How much of the deadline is left, as a guest experiences it.
 *
 * Three states rather than a boolean, because the one date a guest has to act
 * on should read differently a month out, a few days out, and once it is gone.
 * The fourth case is `null` — this wedding has no deadline — which renders
 * nothing at all.
 */
export type RsvpDeadlineState = "open" | "closing-soon" | "closed";

/**
 * How close "closing soon" is: the final week.
 *
 * Measured against `closesAt` — the instant the API already resolved as the
 * last millisecond of the deadline's day in the wedding's own zone — rather
 * than against a count of calendar days. Counting days would mean re-deriving
 * the wedding's zone offset on the client, and an hour of DST drift at the edge
 * of a seven-day band is invisible to a guest.
 */
export const RSVP_SOON_WINDOW_DAYS = 7;

const SOON_WINDOW_MS = RSVP_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Which of the three states this deadline is in. `null` ONLY for a wedding with
 * no deadline — every real deadline gets one of the three, so the notice can
 * never vanish while the buttons stay locked.
 *
 * `closed` is decided by {@link isRsvpClosed}, which the Respond buttons and the
 * RSVP sheet also hang off, so the surfaces cannot disagree. An unparseable
 * `closesAt` that is not closed reads `open`: nearness cannot be measured from
 * a broken instant, and overstating urgency on malformed data is the worse
 * failure — the same direction `isRsvpClosed` already fails.
 */
export function rsvpDeadlineState(
  deadline: RsvpDeadline | null | undefined,
  now: Date,
): RsvpDeadlineState | null {
  if (!deadline) return null;
  if (isRsvpClosed(deadline, now)) return "closed";
  const closesAt = Date.parse(deadline.closesAt);
  if (Number.isNaN(closesAt)) return "open";
  return closesAt - now.getTime() <= SOON_WINDOW_MS ? "closing-soon" : "open";
}

/** Has the deadline passed? `null` (no deadline) is never closed. */
export function isRsvpClosed(deadline: RsvpDeadline | null | undefined, now: Date): boolean {
  if (!deadline) return false;
  const closesAt = Date.parse(deadline.closesAt);
  // An unparseable instant falls back to the server's own verdict rather than
  // guessing — and if that is missing too, the invite stays OPEN. Locking a
  // guest out on malformed data is the worse failure; the write path still
  // refuses a genuinely late reply.
  if (Number.isNaN(closesAt)) return deadline.closed;
  return now.getTime() > closesAt;
}

/**
 * Day formatters keyed by zone. Constructing one is the expensive part (~75µs)
 * while `format` on an existing instance is cheap, and this is called from a
 * reactive scope plus the modal's `closedOn` prop. Only successful
 * lookups are cached, so an unknown zone costs a throwaway construction and
 * stores nothing; the keys that land come from the API payload and are already
 * validated, so the map is bounded by the real IANA set.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timezone: string): Intl.DateTimeFormat | null {
  const cached = dayFormatters.get(timezone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    dayFormatters.set(timezone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/**
 * The deadline day in words — "Sunday 1 September 2026" — read in the wedding's
 * OWN zone, so a guest in another country sees the date the couple wrote, not
 * the one their own clock would roll it to.
 */
export function formatDeadlineDay(deadline: RsvpDeadline): string {
  const at = Date.parse(`${deadline.date}T12:00:00Z`);
  if (Number.isNaN(at)) return deadline.date;
  // An unknown zone (a payload from a newer/other API) still renders a date.
  return dayFormatter(deadline.timezone)?.format(new Date(at)) ?? deadline.date;
}

/**
 * The line that labels the event list: an invitation to reply while the door is
 * open, a push once the week is running out, a statement of fact once it has
 * shut. `null` ⇒ render nothing, which is what a wedding with no deadline gets.
 *
 * Each state says something different in WORDS, not only in colour — the box
 * and the ink around it are the second signal, never the only one (WCAG 1.4.1).
 *
 * Takes the state rather than a clock so the notice, the disabled Respond
 * buttons and the read-only sheet can't disagree: the caller derives the state
 * once (see `createRsvpDeadlineState`) and everything hangs off it.
 */
export function deadlineNotice(
  deadline: RsvpDeadline | null | undefined,
  state: RsvpDeadlineState | null,
): string | null {
  if (!deadline || !state) return null;
  const day = formatDeadlineDay(deadline);
  if (state === "closed") return `RSVPs closed on ${day}.`;
  if (state === "closing-soon") return `RSVPs close soon — kindly respond by ${day}.`;
  return `Kindly respond by ${day}.`;
}

/**
 * The same fact as a short line for the claim panel, where a guest lands: a
 * label and a date rather than a sentence, because it sits under a greeting
 * among other facts about the household rather than on top of a list.
 *
 * Kept distinct from {@link deadlineNotice} so the two copies a guest meets read
 * as two statements rather than as one sentence printed twice.
 */
export function deadlineSummary(
  deadline: RsvpDeadline | null | undefined,
  state: RsvpDeadlineState | null,
): string | null {
  if (!deadline || !state) return null;
  const day = formatDeadlineDay(deadline);
  if (state === "closed") return `RSVPs closed on ${day}`;
  if (state === "closing-soon") return `RSVP by ${day} — closing soon`;
  return `RSVP by ${day}`;
}
