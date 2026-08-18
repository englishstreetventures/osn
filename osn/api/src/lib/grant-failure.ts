/**
 * Does a failed `POST /token` prove the caller's session cookie is dead?
 *
 * The `osn_has_session` marker is a cache of "a session cookie exists in this
 * browser", and a fresh tab with no local account state consults nothing else
 * before deciding whether to attempt a grant at all. So only evidence that the
 * COOKIE is dead may retract it. Two failures say nothing of the kind:
 *
 *   - `DatabaseError` — a storage blip. Evidence about the request.
 *   - the CAS-lost `AuthError` from `refreshTokens` — a concurrent grant of the
 *     same token rotated it out first. PR #289 established this as expected
 *     under concurrent tabs, and the winning grant already set a fresh cookie.
 *
 * Retracting on either turns a transient 400 into a permanent signed-out state
 * for exactly the cold-start population the marker exists to serve (S-M2). The
 * server already knows the difference; this is the predicate that keeps it.
 */

import { Cause, Option, Runtime } from "effect";

/**
 * A service failure carrying an Effect `Data.TaggedError` discriminator — the
 * only shape this predicate can read an answer from.
 */
interface TaggedServiceError extends Error {
  readonly _tag: string;
}

function isTaggedServiceError(value: unknown): value is TaggedServiceError {
  return value instanceof Error && "_tag" in value && typeof value._tag === "string";
}

/**
 * Unwrap a `FiberFailure` to its typed failure — or take the value as thrown —
 * and narrow it to a tagged service error. Route handlers run effects through
 * `ManagedRuntime.runPromise`, which rejects with a `FiberFailure` wrapping the
 * failure, never the tagged error itself. `null` for a defect or any other
 * value, which the caller reads as "no evidence".
 */
function taggedFailure(e: unknown): TaggedServiceError | null {
  const failure = Runtime.isFiberFailure(e)
    ? Option.getOrNull(Cause.failureOption(e[Runtime.FiberFailureCauseId]))
    : e;
  return isTaggedServiceError(failure) ? failure : null;
}

/**
 * True when the failure leaves the session cookie's status unknown, so the
 * marker must be left standing.
 *
 * Defaults to `false` — an unrecognised failure retracts. That is the safer
 * default for a cache: a wrongly-retracted marker costs one sign-in and heals
 * on the next successful ceremony, while a wrongly-kept marker re-arms a
 * pointless grant on every page load, which is the cost this branch removes.
 */
export function sessionStatusUnknown(e: unknown): boolean {
  const failure = taggedFailure(e);
  if (!failure) return false;
  if (failure._tag === "DatabaseError") return true;
  if (failure._tag === "AuthError") return failure.message === ROTATION_RACE_MESSAGE;
  return false;
}

/**
 * The CAS-lost failure message, shared with `refreshTokens` so the two cannot
 * drift apart. Matching on a message is not lovely, but `AuthError` carries no
 * other discriminator and widening its shape would touch every auth route;
 * the constant plus this comment is the cheaper guarantee.
 */
export const ROTATION_RACE_MESSAGE = "Session rotated by a concurrent grant";
