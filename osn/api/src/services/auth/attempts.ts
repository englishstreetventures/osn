/**
 * The guess count every code-checking ceremony keeps: step-up OTP, the
 * emailed recovery code, TOTP enrolment, email change and registration.
 *
 * The count lives on the pending entry itself, and one store call both reads
 * the entry and counts the guess against it (`CeremonyStore.guess`). The life
 * of one count:
 *
 * - `begin` writes a new entry, which starts its count at 0, so a new code is
 *   never refused for the old one's guesses.
 * - `complete` guesses ({@link guessEntry}): the entry and the count after
 *   this guess, in one atomic call. No entry, or an expired one, counts
 *   nothing and is refused — there is nothing to guess against.
 * - The guess that reaches the cap, if wrong, deletes the entry
 *   ({@link spendEntry}), and its count with it. Every guess past the cap is
 *   refused without the code being compared. Because the read and the count
 *   are one call, no guess can read the entry and then count from a number
 *   the entry no longer has; a guess that arrives after the delete finds
 *   nothing and counts nothing. A guess past the cap does not delete the entry
 *   again, so a right code that reached the cap is not robbed of its claim by
 *   the guesses behind it.
 * - A right code claims the entry ({@link claimEntry}: of two right codes
 *   exactly one wins) or, where the commit that follows must succeed first,
 *   deletes it after the commit. Email change deletes only the entry its guess
 *   read (`CeremonyStore.delete` with that value), since its `begin`
 *   overwrites the entry at the same key; registration's `begin` cannot write
 *   over a live entry, nor at the key of an address that has an account.
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

/** A guess counted against a live entry. */
export interface CountedGuess<V> {
  readonly entry: V;
  readonly standing: AttemptStanding;
}

/**
 * Read the entry at `key`, which allows `max` guesses in all, and count this
 * guess against it, in one store call. `null` when there is no live entry —
 * nothing was counted — or when the entry's own expiry has passed.
 */
export const guessEntry = <V extends { readonly expiresAt: number }>(
  store: CeremonyStore<V>,
  key: string,
  max: number,
): Effect.Effect<CountedGuess<V> | null, CoordinationError> =>
  Effect.gen(function* () {
    const { value, n } = yield* storeCall(store, "guess", () => store.guess(key));
    if (value === null || Date.now() > value.expiresAt) return null;
    if (n > max) return { entry: value, standing: "spent" };
    return { entry: value, standing: n === max ? "last" : "open" };
  });

/** Delete the entry at `key`, and its guess count with it. */
export const spendEntry = <V>(
  store: CeremonyStore<V>,
  key: string,
): Effect.Effect<void, CoordinationError> => storeCall(store, "delete", () => store.delete(key));

/** Claim the entry at `key` for the right code. True for exactly one caller. */
export const claimEntry = <V>(
  store: CeremonyStore<V>,
  key: string,
): Effect.Effect<boolean, CoordinationError> =>
  storeCall(store, "consume", () => store.consume(key));
