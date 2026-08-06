/**
 * Timing contract for the RSVP sheet's confirmed state.
 *
 * ## Why a guest needs this at all
 *
 * A successful RSVP used to be invisible. `handleSubmit` called `onSubmitted`
 * and `onClose` back to back, so the sheet vanished the instant the POST
 * returned and the only evidence anything had happened was a sheet that was no
 * longer there — indistinguishable, to a guest, from a mis-tap that dismissed
 * it. The reply had been recorded and nothing said so.
 *
 * The fix is a confirmed state that is deliberately *held*: the Save button
 * fills gold left-to-right, a tick draws in, and only then does the sheet close
 * itself. The delay is the feature — it is the window in which the guest reads
 * the confirmation.
 *
 * ## Why the numbers live here rather than only in the classes
 *
 * The sweep and the tick are CSS (a `transition` on the fill, a keyframe for
 * the tick), which is what earns them reduced-motion handling for free: the
 * global `prefers-reduced-motion` block in `global.css` clamps both to 0.01ms,
 * so a guest who asks for less motion lands on the finished state instantly
 * instead of watching it travel.
 *
 * The dwell, though, cannot be CSS — it gates a `props.onClose()` call, so it
 * is a `setTimeout` in the component. That splits one piece of choreography
 * across two languages, and the halves can drift apart silently: shorten the
 * dwell below the sweep and the sheet starts closing over a half-drawn tick,
 * which no type check, no build and no happy-dom test would notice (jsdom and
 * happy-dom compute no CSS at all). So the durations are stated once, here, and
 * pinned from both sides — `rsvp-saved.test.ts` asserts the dwell outlasts the
 * animation, `RsvpModal.test.tsx` asserts the button's Tailwind classes still
 * spell these values, and `global.css`'s own drift guard asserts the keyframe
 * does.
 *
 * Deliberately NOT clamped under reduced motion. Cutting the dwell along with
 * the animation would close the sheet ~0ms after it confirmed, which is the
 * original bug wearing a tick. Less motion is a request for less *movement*,
 * not less time to read.
 */

/**
 * The gold fill's left-to-right sweep. Must equal the `duration-500` utility on
 * the fill layer in `RsvpModal`.
 */
export const SWEEP_DURATION_MS = 500;

/**
 * How long the tick waits before drawing, so it lands *into* gold rather than
 * racing the fill across an unpainted button. Must equal the delay in the
 * `--animate-tick-draw` definition in `global.css`.
 */
export const TICK_DELAY_MS = 180;

/** The tick's stroke draw. Must equal the duration in `--animate-tick-draw`. */
export const TICK_DURATION_MS = 340;

/**
 * How long the label waits before flipping to the on-gold ink colour, so it
 * changes as the fill reaches the text rather than before the sweep sets off.
 * Must equal the `delay-200` utility on the label span in `RsvpModal`.
 *
 * Part of the contract for the same reason as the rest (T-M3): losing the flip
 * leaves gold text and a gold-stroked tick painted on the gold fill — the
 * confirmation goes low-contrast at exactly the moment it has to be read — and
 * letting the delay drift past the sweep lands the flip after the fill has
 * already arrived.
 */
export const INK_FLIP_DELAY_MS = 200;

/**
 * How long the confirmed state holds before the sheet closes itself, measured
 * from the moment the server's 200 lands (not from the end of the animation),
 * so the total wait after a successful submit is a fixed, predictable beat.
 *
 * Timed rather than driven off the sweep's `transitionend`: under reduced
 * motion that event fires ~immediately (the global block clamps the duration to
 * 0.01ms precisely so listeners still fire), which would slam the sheet shut
 * before the confirmation could be read.
 */
export const SAVED_DWELL_MS = 900;

/** When the confirmation has finished animating, relative to the same origin. */
export const CONFIRMATION_END_MS = Math.max(SWEEP_DURATION_MS, TICK_DELAY_MS + TICK_DURATION_MS);
