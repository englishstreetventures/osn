/**
 * Safe route-level error message extraction (S-M17).
 *
 * Route handlers execute service effects via `ManagedRuntime.runPromise`
 * (see `makeAppRunner`), which rejects with a `FiberFailure` wrapping the
 * typed failure — never the tagged error itself. A plain `_tag` check on the
 * caught value therefore never matches, and every business-rule failure
 * ("Connection already exists", "Cannot connect to yourself", …) collapses
 * into the generic "Request failed". This helper unwraps the `FiberFailure`
 * cause first, then applies the tag allowlist; anything not allow-listed
 * (`DatabaseError`, defects) still collapses to the generic message so DB
 * internals never leave the server.
 */

import { Cause, Option, Runtime } from "effect";

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
 * Unwrap a `FiberFailure` to its typed failure — or take the value as thrown —
 * and narrow it to a tagged service error. `null` for a defect, a plain `Error`
 * or any other value, none of which carries a message fit to return.
 */
function taggedFailure(e: unknown): TaggedServiceError | null {
  const failure = Runtime.isFiberFailure(e)
    ? Option.getOrNull(Cause.failureOption(e[Runtime.FiberFailureCauseId]))
    : e;
  return isTaggedServiceError(failure) ? failure : null;
}

/**
 * Build a `safeError` that surfaces only the message of allow-listed tagged
 * service errors. Accepts both a raw tagged error and a `FiberFailure`
 * wrapping one, so it works for effects run through a `ManagedRuntime` and
 * for errors thrown directly.
 */
export function makeSafeError(allowedTags: readonly string[]): (e: unknown) => string {
  const tags = new Set(allowedTags);
  return (e: unknown): string => {
    const failure = taggedFailure(e);
    return failure && tags.has(failure._tag) ? failure.message : GENERIC_MESSAGE;
  };
}
