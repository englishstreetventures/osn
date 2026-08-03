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

/** Unwrap a `FiberFailure` to its typed failure; pass anything else through. */
function unwrapFailure(e: unknown): unknown {
  if (Runtime.isFiberFailure(e)) {
    return Option.getOrNull(Cause.failureOption(e[Runtime.FiberFailureCauseId]));
  }
  return e;
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
    const failure = unwrapFailure(e);
    if (
      failure instanceof Error &&
      "_tag" in failure &&
      typeof failure._tag === "string" &&
      tags.has(failure._tag) &&
      typeof failure.message === "string"
    ) {
      return failure.message;
    }
    return GENERIC_MESSAGE;
  };
}
