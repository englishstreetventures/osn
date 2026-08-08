import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

/**
 * True once every member of the household invited to this event has an RSVP
 * row on file for it. RSVP submission is no longer atomic per event —
 * `RsvpModal` lets a household save with only SOME visible members answered,
 * sending just that subset — so this is the check that has to run the full
 * `.every(...)` walk rather than trusting any one row to stand in for the
 * whole party.
 *
 * `RsvpModal` computes the equivalent fact for itself (`handleSubmit`'s
 * `nowComplete` — every visible member's LOCAL form state is non-null,
 * counting a prior reply prefilled by `initialResponses` as answered) rather
 * than calling this function, since it needs the answer synchronously from
 * form state before a submit round-trips; a save only earns the
 * Respond-button celebration, on top of the toast every save gets, once that
 * check comes back true.
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
 * Two phases, driven entirely inside `EventCard` from a single
 * `justResponded` transition (see the component for the state machine):
 *
 * 1. **Sweep-in** (0 → `SWEEP_DURATION_MS`): the button's fill sweeps from
 *    gold to `bg-bloom` left-to-right, and a tick draws into it — the same
 *    `--animate-tick-draw` keyframe `rsvp-saved.ts` used to document,
 *    unmoved in `global.css`.
 * 2. **Hold** (→ `HOLD_MS` = `TOTAL_DURATION_MS`): the filled, ticked button
 *    sits still long enough to actually read, then stays exactly as it is —
 *    there is no fade-out. The fill and the tick are both permanent once the
 *    sweep-in has played: a guest who reopens the invite tomorrow sees the
 *    same filled, ticked button a guest who just submitted settles into.
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
 * How long the filled, ticked state holds before settling. Comfortably past
 * `TICK_DRAW_END_MS` so the hold is a readable beat, not the animation's last
 * frame wearing a different name.
 */
export const HOLD_MS = 900;

/**
 * When the whole celebration is over and `EventCard` reports it via
 * `onCelebrated` — equal to `HOLD_MS`, since there is no fade-out sweep to
 * wait through: the fill and tick are already in their permanent state once
 * the hold ends.
 */
export const TOTAL_DURATION_MS = HOLD_MS;
