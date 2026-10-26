/**
 * The guess count every code-checking ceremony keeps: step-up OTP, the
 * emailed recovery code, TOTP enrolment, email change and registration.
 *
 * The life of one count, per pending entry:
 *
 * - `begin` writes a new entry and clears the count ({@link restartAttempts}),
 *   so a new code is never refused for the old one's guesses.
 * - `complete` reads the entry first. No entry, or an expired one, is refused
 *   without counting — there is nothing to guess against.
 * - Otherwise the guess is counted ({@link countAttempt}) before the code is
 *   compared. The count is one atomic increment in the store, so guesses sent
 *   at once each take their own number.
 * - The guess that reaches the cap, if wrong, deletes the entry
 *   ({@link spendEntry}). Every guess past the cap is refused without the code
 *   being read; while the count stands, no later guess is read either, even
 *   one that read the entry before it was deleted. The count is left to
 *   expire with the entry's lifetime rather than cleared, for that reason —
 *   and the entry is not deleted again past the cap, so a right code that
 *   reached the cap is not robbed of its claim by the guesses behind it.
 * - A right code claims the entry (`consume`, so of two right codes exactly
 *   one wins) or, where the commit that follows must succeed first, deletes it
 *   after the commit; then the count is cleared.
 */

import { Effect } from "effect";

import type { CeremonyStore } from "../../lib/ceremony-store";
import type { CoordinationError } from "./errors";
import { storeCall } from "./store-call";

/**
 * Where a counted guess stands. `open`: under the cap. `last`: the guess that
 * reaches it — a wrong code here spends the entry. `spent`: past it; refuse
 * without comparing.
 */
export type AttemptStanding = "open" | "last" | "spent";

/** Count one guess against `entry` at `key`, which allows `max` in all. */
export const countAttempt = <V extends { readonly expiresAt: number }>(
  store: CeremonyStore<V>,
  key: string,
  entry: V,
  max: number,
): Effect.Effect<AttemptStanding, CoordinationError> =>
  Effect.gen(function* () {
    // The count lives as long as the entry has left, and at least 1 ms: the
    // store refuses an empty window.
    const window = Math.max(1, entry.expiresAt - Date.now());
    const n = yield* storeCall(store, "recordAttempt", () => store.recordAttempt(key, window));
    if (n > max) return "spent";
    return n === max ? "last" : "open";
  });

/** Delete the entry at `key`; its guess count expires on its own. */
export const spendEntry = <V>(
  store: CeremonyStore<V>,
  key: string,
): Effect.Effect<void, CoordinationError> => storeCall(store, "delete", () => store.delete(key));

/** Clear the guess count at `key`, as a new entry is written or one is used. */
export const restartAttempts = <V>(
  store: CeremonyStore<V>,
  key: string,
): Effect.Effect<void, CoordinationError> =>
  storeCall(store, "clearAttempts", () => store.clearAttempts(key));

/**
 * Claim the entry at `key` for the right code. True for exactly one caller;
 * the count is cleared once it is.
 */
export const claimEntry = <V>(
  store: CeremonyStore<V>,
  key: string,
): Effect.Effect<boolean, CoordinationError> =>
  Effect.gen(function* () {
    const won = yield* storeCall(store, "consume", () => store.consume(key));
    if (won) yield* restartAttempts(store, key);
    return won;
  });
