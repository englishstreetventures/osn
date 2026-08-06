/**
 * Timing contract for the RSVP sheet's confirmed state.
 *
 * ## Why a guest needs this at all
 *
 * A successful RSVP used to be invisible. `handleSubmit` called `onSubmitted`
 * and `onClose` back to back, so the sheet vanished the instant the POST
 * returned and the only evidence anything had happened was a sheet that was
 * no longer there — indistinguishable, to a guest, from a mis-tap that
 * dismissed it. The reply had been recorded and nothing said so.
 *
 * ## Where the confirmation itself lives now
 *
 * The Save button used to carry the confirmation — a gold sweep and a drawn
 * tick — but that button is gone the moment the sheet closes over it, which
 * is exactly when a guest would otherwise have time to register it. The
 * animated confirmation moved to the events section's Respond button, which
 * stays on screen after the sheet closes; see `rsvp-responded.ts` for that
 * choreography. What is left here is just the dwell: the Save button swaps
 * its label to "Saved", locks the sheet's controls, and holds for
 * `SAVED_DWELL_MS` before closing itself — long enough that the sheet still
 * doesn't just vanish, short enough that it doesn't feel stuck.
 */

/**
 * How long the confirmed state holds before the sheet closes itself, measured
 * from the moment the server's 200 lands.
 */
export const SAVED_DWELL_MS = 900;
