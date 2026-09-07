/**
 * Safe route-level error message extraction (S-M17).
 *
 * Route handlers execute service effects through `makeAppRunner`'s `run`
 * (`lib/route-runtime.ts`), which rejects with the effect's TYPED failure — the
 * first `Fail` error in the `Cause` — and with a tagless `OpaqueDefect` for
 * anything else. This module applies the tag allowlist to whatever that
 * rejection carried: an allow-listed tag returns its message, and everything
 * else (`DatabaseError`, defects, plain `Error`s, non-errors) collapses to the
 * generic message, so DB internals never leave the server.
 *
 * Two guarantees, and it matters which one is doing which job:
 *
 *   - The RUNNER guarantees only a value a service deliberately put in its
 *     error channel can reach the tag check at all.
 *   - The ALLOWLIST guarantees that, of those, only the tags whose messages are
 *     audited static literals get their message forwarded
 *     (`tests/lib/safe-error-static-messages.test.ts` enforces the literals).
 *
 * The allowlist alone is NOT enough, which is the whole reason the runner does
 * the first job. `Data.TaggedError` produces real `Error` subclasses carrying a
 * `_tag`, so an allow-listed tag on an `Error` is not by itself evidence the
 * value came from `Effect.fail`: `Effect.die`, `Effect.orDie` (used in
 * `routes/graph.ts`, `routes/recommendations.ts`, `routes/organisation.ts`) and
 * a bare `throw` inside `Effect.sync` all wrap the same class as a DEFECT. Under
 * Effect v4, `Cause.squash` — what a plain `ManagedRuntime.runPromise` rejects
 * with — hands that defect object back verbatim, so it would arrive here fully
 * dressed as an allow-listed failure and its message, an internal invariant
 * written for an operator, would be returned to a client. (Under v3 the
 * `FiberFailure` wrapper plus `Cause.failureOption` answered `None` for a
 * defect, which is why this module was once written as though the allowlist
 * were sufficient.) `OpaqueDefect` carries no `_tag` at all, so the check below
 * cannot match one.
 */

const GENERIC_MESSAGE = "Request failed";

/**
 * A service failure carrying an Effect `Data.TaggedError` discriminator — the
 * only shape this module can say anything about.
 */
interface TaggedServiceError extends Error {
  readonly _tag: string;
}

function isTaggedServiceError(value: unknown): value is TaggedServiceError {
  return (
    value instanceof Error &&
    "_tag" in value &&
    typeof value._tag === "string" &&
    typeof value.message === "string"
  );
}

/**
 * Narrow a rejected value to a tagged service error. `null` for a plain `Error`
 * (including an `OpaqueDefect`) or any other value, none of which carries a
 * message fit to return.
 *
 * There is no wrapper to unwrap: Effect v4 removed `FiberFailure`, and the
 * runner rejects with the typed failure itself.
 */
function taggedFailure(e: unknown): TaggedServiceError | null {
  return isTaggedServiceError(e) ? e : null;
}

/**
 * Build a `safeError` that surfaces only the message of allow-listed tagged
 * service errors.
 *
 * Takes `unknown` and is total, so it is equally safe on a value thrown outside
 * an effect — but the containment it is part of is only whole when the effect
 * was run through `makeAppRunner`'s `run`. Reaching for a raw
 * `runtime.runPromise` and passing its rejection here re-opens the defect hole
 * described above.
 */
export function makeSafeError(allowedTags: readonly string[]): (e: unknown) => string {
  const tags = new Set(allowedTags);
  return (e: unknown): string => {
    const failure = taggedFailure(e);
    return failure && tags.has(failure._tag) ? failure.message : GENERIC_MESSAGE;
  };
}
