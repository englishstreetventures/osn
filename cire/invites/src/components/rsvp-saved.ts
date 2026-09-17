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
 * ## The dwell is a budget, and the floor is an accessibility floor
 *
 * {@link SAVED_DWELL_MS} is a budget spent from the CLICK, not a hold started
 * when the reply lands, so a slow round-trip eats it instead of stacking on it.
 * {@link SAVED_DWELL_MIN_MS} is the floor below it, sized by the sheet's spoken
 * `role="status"` confirmation rather than by the visible label swap — an
 * accessibility floor, not a timing preference, so do not lower it.
 * `rsvp-saved.test.ts` pins the knee between the two as a relationship, so it
 * stays true of whatever they are retuned to.
 *
 * Nothing downstream is timed against these numbers: the Respond-button
 * celebration is measured from the moment the sheet uncovers that button (see
 * `rsvp-responded.ts`), and the toast is already up and stays up past the
 * close. So shortening the dwell shortens the wait and nothing else.
 *
 * @see wiki/decisions/rsvp-dwell-as-budget-with-announcement-floor.md — why
 * both constants, and the way to get the floor's cost back.
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
 * swap, which would be legible in half the time.
 *
 * @see wiki/decisions/rsvp-dwell-as-budget-with-announcement-floor.md
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
