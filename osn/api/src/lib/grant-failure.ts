/**
 * Does a failed `POST /token` leave the caller's session cookie in doubt?
 *
 * The `osn_has_session` marker is a cache of "a session cookie exists in this
 * browser", and a fresh tab with no local account state consults nothing else
 * before deciding whether to attempt a grant at all. Every refusal retracts it
 * except two failures that say nothing about the cookie:
 *
 *   - `DatabaseError` — a storage blip. Evidence about the request.
 *   - the CAS-lost `AuthError` from `refreshTokens` — a concurrent grant of the
 *     same token rotated it out first, which concurrent tabs do, and the
 *     winning grant already set a fresh cookie.
 *
 * Retracting on either turns a transient 400 into a signed-out state for
 * exactly the cold-start population the marker exists to serve. The server
 * already knows the difference; this is the predicate that keeps it. A grant
 * refused for what it asked — a profile the cookie's account does not own, a
 * replaced handle naming none — retracts though the cookie is live: the page
 * that sent it signs out, and a cold load should show that too.
 */

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
 * Narrow a rejected value to a tagged service error. `null` for any other
 * value, which the caller reads as "no evidence".
 *
 * There is no wrapper to unwrap: Effect v4 removed `FiberFailure`, and route
 * handlers run effects through `makeAppRunner`'s `run` (`lib/route-runtime.ts`),
 * which rejects with the typed failure itself.
 *
 * That runner, not this narrowing, is what keeps the predicate honest, and it
 * matters here because this feeds a security decision rather than a message.
 * A `Data.TaggedError` IS an `Error` with a `_tag`, so `Effect.die`,
 * `Effect.orDie` or a bare `throw` inside `Effect.sync` produce a DEFECT that
 * still looks exactly like a tagged failure — and Effect v4's `Cause.squash`
 * (what a plain `ManagedRuntime.runPromise` rejects with) would hand that
 * object straight to the check below, so an internal invariant blowing up
 * anywhere under `POST /token` could answer "status unknown" and pin the
 * marker up. The runner instead rejects defects as a tagless `OpaqueDefect`,
 * which falls through to `null` here and therefore to the retracting default:
 * only a failure a service deliberately put in its error channel can say
 * anything about the cookie.
 */
function taggedFailure(e: unknown): TaggedServiceError | null {
  return isTaggedServiceError(e) ? e : null;
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
