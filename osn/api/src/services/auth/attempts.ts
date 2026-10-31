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
 *   exactly one wins). Registration, whose insert must succeed first, deletes
 *   it after the insert instead.
 *
 * The delete and the claim name the entry the guess read, and remove only
 * that entry: a `begin` that lands between the guess and either call writes a
 * new entry at the same key, which stays, with its count, and the old code
 * wins nothing. A call that finds the new entry writes nothing where one that
 * removes the old entry writes, so the two cost differently only when a
 * `begin` landed in that gap. On the one unauthenticated refusal path that
 * deletes — registration's capped guess — that needs the old entry to have
 * expired in the gap, since a registration `begin` writes only where nothing
 * is live.
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

/**
 * Delete `entry`, the one a guess read at `key`, and its guess count with it,
 * while it is still the live one.
 */
export const spendEntry = <V>(
  store: CeremonyStore<V>,
  key: string,
  entry: V,
): Effect.Effect<void, CoordinationError> =>
  storeCall(store, "delete", () => store.delete(key, entry));

/**
 * Claim `entry`, the one a guess read at `key`, for the right code. True for
 * exactly one caller, and only while `entry` is still the live one.
 */
export const claimEntry = <V>(
  store: CeremonyStore<V>,
  key: string,
  entry: V,
): Effect.Effect<boolean, CoordinationError> =>
  storeCall(store, "consume", () => store.consume(key, entry));
