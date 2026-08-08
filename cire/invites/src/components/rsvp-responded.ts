import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

/**
 * True once every member of the household invited to this event has an RSVP
 * row on file for it. RSVP submission is no longer atomic per event —
 * `RsvpModal` lets a household save with only SOME visible members answered,
 * sending just that subset — so this is the check that has to run the full
 * `.every(...)` walk rather than trusting any one row to stand in for the
 * whole party.
 *
 * This is the source of the PERMANENT mark on Respond: `EventCard` seeds its
 * `confirmed` state from this at mount and re-syncs whenever it becomes true
 * (once the sheet is no longer covering the button). `RsvpModal` computes the
 * equivalent fact for itself (`handleSubmit`'s `nowComplete` — every visible member's LOCAL form state is non-null,
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
 * closes, not when the reply is recorded — the two are one dwell apart
 * (`savedDwellMs`), and this whole choreography outlasts that dwell. Started at
 * record-time it would play its first few hundred ms under a sheet that is
 * still covering the button, so keep `TOTAL_DURATION_MS` and the dwell
 * independent: the celebration is measured from the moment the button becomes
 * visible, not from the submit. That independence is exactly what let the dwell
 * be shortened without retuning anything here.
 *
 * The end state is PERMANENT, and these numbers only describe how it is
 * reached. `EventCard` holds the mark in one monotone signal that nothing sets
 * back to false, so there is no phase after which the fill comes off — a guest
 * who reopens the invite tomorrow sees exactly what a guest who just submitted
 * settles into. Two earlier versions of this got that wrong in ways no test
 * caught: #395 spent a phase sweeping the fill back OUT, and #396 kept the
 * fill but unmounted the tick when the timer below expired on any path where
 * `responded` was false. Both are guarded now by
 * `EventCard.browser.test.tsx`, which measures the painted fill seconds after
 * every timer here has run out.
 *
 * Two phases, driven entirely inside `EventCard` from a single
 * `justResponded` transition (see the component for the state machine):
 *
 * 1. **Sweep-in** (0 → `SWEEP_DURATION_MS`): the button's fill sweeps from
 *    gold to `bg-bloom` left-to-right, and a tick draws into it — the same
 *    `--animate-tick-draw` keyframe `rsvp-saved.ts` used to document,
 *    unmoved in `global.css`.
 * 2. **Settle** (→ `TOTAL_DURATION_MS`): the filled, ticked button sits still
 *    long enough to read, and then simply stays. All that expires at the end
 *    is the tick's draw animation and the parent's `justResponded` cue.
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
 * When the animation is over and `EventCard` reports it via `onCelebrated` —
 * equal to `HOLD_MS`, since there is no fade-out sweep to wait through.
 *
 * Note what this instant does NOT do: it does not end the confirmation. The
 * fill and the tick are already permanent by the time it arrives, and all it
 * retires is the tick's `stroke-dashoffset` keyframe and the parent's
 * `justResponded` cue (so an edited re-submit is a fresh false→true
 * transition). Anything that switches a visible piece of the mark off here is
 * the bug this constant has now been at the centre of twice.
 */
export const TOTAL_DURATION_MS = HOLD_MS;
