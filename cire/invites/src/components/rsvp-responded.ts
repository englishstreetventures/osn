import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

/**
 * True once every member of the household invited to this event has an RSVP
 * row on file for it. RSVP submission is atomic per event — `RsvpModal`
 * requires every visible member to be answered before it will submit, and
 * sends them in one request — so "all invited members have a row" and "any
 * invited member has a row" are the same fact in practice; checking all of
 * them is the one that stays correct if that ever stops being true.
 *
 * An event nobody in the household is invited to reports `false` — there is
 * nothing to have responded to, so a permanent tick would be a lie.
 */
export function hasHouseholdResponded(
  event: Pick<EventSummary, "id">,
  members: ReadonlyArray<Pick<FamilyMember, "guestId" | "eventIds">>,
  rsvps: ReadonlyArray<Pick<RsvpSummary, "guestId" | "eventId">>,
): boolean {
  const invited = members.filter((m) => m.eventIds.includes(event.id));
  if (invited.length === 0) return false;
  return invited.every((m) => rsvps.some((r) => r.guestId === m.guestId && r.eventId === event.id));
}

/**
 * Timing contract for the Respond button's confirmation, played on
 * `EventCard` once a household's reply for that event is recorded (PR #380
 * shipped this choreography on the RSVP sheet's Save button instead — a
 * button that is gone by the time a guest could register it, since the sheet
 * closes itself over it. Moving it here puts the confirmation on the control
 * that is still on screen afterwards).
 *
 * The cue that starts it (`RsvpModal`'s `onConfirmed`) fires as the sheet
 * closes, not when the reply is recorded — the two are `SAVED_DWELL_MS` apart,
 * and this whole choreography outlasts that dwell. Started at record-time it
 * would play its first ~900ms under a sheet that is still covering the button,
 * so keep `TOTAL_DURATION_MS` and the dwell independent: the celebration is
 * measured from the moment the button becomes visible, not from the submit.
 *
 * Three phases, driven entirely inside `EventCard` from a single
 * `justResponded` transition (see the component for the state machine):
 *
 * 1. **Sweep-in** (0 → `SWEEP_DURATION_MS`): the button's fill sweeps from
 *    gold to `bg-success` left-to-right, and a tick draws into it — the same
 *    `--animate-tick-draw` keyframe `rsvp-saved.ts` used to document,
 *    unmoved in `global.css`.
 * 2. **Hold** (→ `HOLD_MS`): the filled, ticked button sits still long enough
 *    to actually read.
 * 3. **Fade** (→ `TOTAL_DURATION_MS`): the fill sweeps back out over another
 *    `SWEEP_DURATION_MS`, and the tick — which stays mounted throughout —
 *    switches from the on-fill ink to a permanent `text-success` green. That
 *    switch is what survives: the fill is gone at the end of this phase, the
 *    tick is not, and nothing further ever un-shows it for this event.
 */

/** The fill's sweep, in either direction — must equal the `duration-500` utility on the fill layer. */
export const SWEEP_DURATION_MS = 500;

/** Matches `--animate-tick-draw`'s delay in `global.css` — unchanged from the Save-button era. */
export const TICK_DELAY_MS = 180;

/** Matches `--animate-tick-draw`'s duration in `global.css` — unchanged from the Save-button era. */
export const TICK_DURATION_MS = 340;

/** The instant the tick's stroke finishes drawing, relative to celebration start. */
export const TICK_DRAW_END_MS = TICK_DELAY_MS + TICK_DURATION_MS;

/**
 * How long the filled, ticked state holds before fading back out. Comfortably
 * past `TICK_DRAW_END_MS` so the hold is a readable beat, not the animation's
 * last frame wearing a different name.
 */
export const HOLD_MS = 900;

/** When the whole celebration is over and `EventCard` reports it via `onCelebrated`. */
export const TOTAL_DURATION_MS = HOLD_MS + SWEEP_DURATION_MS;
