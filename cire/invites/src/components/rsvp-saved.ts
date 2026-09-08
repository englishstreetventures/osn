/**
 * Timing contract for the RSVP sheet's confirmed state.
 *
 * ## Why a guest needs this at all
 *
 * The sheet must not vanish the instant the POST returns. A sheet that is
 * simply gone is indistinguishable, to a guest, from a mis-tap that dismissed
 * it — the reply is recorded and nothing says so.
 *
 * ## Where the confirmation lives
 *
 * The animated confirmation lives on the events section's Respond button, not
 * on Save — Save is gone the moment the sheet closes over it, which is exactly
 * when a guest would otherwise have time to register it. The Respond button
 * stays on screen after the close; see `rsvp-responded.ts` for that
 * choreography. What is left here is just the dwell: the Save button swaps its
 * label to "Saved", locks the sheet's controls, and holds briefly before
 * closing itself — long enough that the sheet still doesn't just vanish.
 *
 * ## Why the dwell is a BUDGET, not a fixed hold
 *
 * The dwell is a budget spent from the CLICK, not a hold started when the reply
 * lands — do not reintroduce a fixed hold. It stacks on the round-trip, and the
 * POST is six serialised D1 round-trips behind a Worker: half a second of
 * "Saving…" before the hold begins, which guests read as "quite a delay for the
 * form to close after you click save". A slow reply eats the budget instead.
 *
 * Be precise about how far that goes, because the floor below bounds it. Up to
 * the KNEE — a reply of `SAVED_DWELL_MS - SAVED_DWELL_MIN_MS` — the budget is
 * spent exactly and click-to-close is flat at `SAVED_DWELL_MS`. Past the knee
 * the floor takes over and the total is `request + SAVED_DWELL_MIN_MS`, which
 * grows with the network again. With the floor sized for the announcement (see
 * below) the knee is small, so most real saves land past it and what they
 * actually get is the floor rather than the budget — `900 → 500` of dwell, a
 * flat saving, rather than the constant click-to-close the first paragraph
 * might suggest. The budget still does the work it can: it compresses fast
 * replies and it caps nothing at more than `SAVED_DWELL_MS`. `rsvp-saved.test.ts`
 * pins the knee as a relationship between the two constants so this stays true
 * of whatever they are retuned to.
 *
 * The floor is what keeps that from collapsing into the original bug. A guest
 * whose reply took longer than the whole budget must still SEE the confirmed
 * state — "Saving…" is not a confirmation, and only the dwell shows "Saved" —
 * so the hold never drops below `SAVED_DWELL_MIN_MS` no matter how slow the
 * round-trip was. Below that floor the label swap reads as a flicker and the
 * sheet is back to vanishing.
 *
 * ## Why the floor is 500 and not something snappier
 *
 * The floor is sized by the SPOKEN confirmation, not the visible one. The
 * sheet's `sr-only role="status"` region is the reliable announcement path (the
 * toast's own region is created together with its content, which assistive tech
 * routinely misses), and the dwell timer calls `props.onClose()` directly — no
 * `modalExit` grace period — so the parent unmounts that region on the same
 * tick the dwell expires, while `AnimatedModal` returns focus to the Respond
 * button. A polite region mutated and then destroyed a few hundred ms later,
 * against a competing focus utterance, is at the edge of what iOS VoiceOver
 * reliably speaks (WCAG 2.2 SC 4.1.3) — and this is a phone-first invite, so
 * VoiceOver is the primary AT. Note the floor is the COMMON case, not the tail:
 * it binds for any reply slower than `SAVED_DWELL_MS - SAVED_DWELL_MIN_MS`, and
 * the RSVP POST is six serialised D1 round-trips.
 *
 * So this number is an accessibility floor wearing a timing constant's clothes,
 * and the ~100ms it costs a fast save is the price of the announcement being
 * heard. The way to get it back is NOT to lower it: it is to hoist the live
 * region to the page root beside the `<Toaster>` (relocated there for a
 * structurally identical reason), so the announcement's lifetime stops
 * depending on the dwell.
 *
 * Nothing downstream is timed against these numbers: the Respond-button
 * celebration is measured from the moment the sheet uncovers that button (see
 * `rsvp-responded.ts`), and the toast is already up and stays up past the
 * close. So shortening the dwell shortens the wait and nothing else.
 */

/**
 * The confirmed state's total time-on-screen budget, measured from the moment
 * the guest clicks Save — not from the moment the server answers. Whatever the
 * request spent is deducted from it (see {@link savedDwellMs}), so this is also
 * the LONGEST the sheet can hold: an instant reply dwells for the full budget,
 * and any slower reply dwells for less.
 *
 * Tests advance fake timers by this constant to land the close, which stays
 * correct precisely because it is the maximum.
 */
export const SAVED_DWELL_MS = 600;

/**
 * The floor under {@link savedDwellMs} — the shortest the confirmed state is
 * ever held, applied when the request alone outran the budget above. Sized by
 * the sheet's `role="status"` announcement rather than by the "Saved" label
 * swap, which would be legible in half the time; see the module doc.
 */
export const SAVED_DWELL_MIN_MS = 500;

/**
 * How long to hold the confirmed state, given how long the submit itself took.
 *
 * `requestMs` is wall-clock from the guest's click to the reply landing — 0 for
 * the host preview, which never leaves the browser.
 */
export function savedDwellMs(requestMs: number): number {
  // NaN loses every comparison, so `Math.max` would pass it straight through to
  // `setTimeout` — where a NaN delay fires IMMEDIATELY, i.e. the sheet vanishes
  // with no confirmation at all. Guard it explicitly.
  if (!Number.isFinite(requestMs)) return SAVED_DWELL_MIN_MS;
  // Clamp at zero as well: `Date.now()` is wall-clock and can step backwards
  // (an NTP correction mid-request), and a negative measurement would otherwise
  // ADD to the dwell — the exact failure mode this budget exists to remove, and
  // it would break the invariant every other test leans on, that the budget is
  // the maximum.
  const spent = Math.max(0, requestMs);
  return Math.max(SAVED_DWELL_MIN_MS, SAVED_DWELL_MS - spent);
}
