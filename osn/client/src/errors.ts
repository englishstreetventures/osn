import { Data } from "effect";

export class TokenRefreshError extends Data.TaggedError("TokenRefreshError")<{
  readonly cause: unknown;
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown;
}> {}

export class ProfileManagementError extends Data.TaggedError("ProfileManagementError")<{
  readonly cause: unknown;
}> {}

/**
 * Surfaced from `authFetch` when the access token is expired AND a silent
 * refresh cycle has failed. Callers should redirect the user to sign in.
 */
export class AuthExpiredError extends Data.TaggedError("AuthExpiredError")<{
  readonly cause?: unknown;
}> {}

/**
 * The tag as an error NAME at the head of the printout — bare, or behind the
 * `(FiberFailure)` prefix Effect v3 used to add. Not "anywhere in the string".
 */
const TAGGED_ERROR_PRINTOUT = /^(?:\(FiberFailure\)\s*)?AuthExpiredError\b/;

/**
 * True when `err` is — or wraps — an {@link AuthExpiredError}. Callers use it
 * to decide "bounce to sign-in" versus "show an error".
 *
 * `instanceof AuthExpiredError` is not enough on its own, so consumers were
 * left string-matching the printout by hand (`cire/host/src/lib/api.ts`).
 * This is that predicate, kept next to the class so the two can't drift.
 *
 * Three probes, cheapest first:
 *
 *  1. `instanceof` — the unwrapped error. Effect v4 rejects a `runPromise`
 *     with `Cause.squash(cause)`, which for a typed failure IS this instance,
 *     so this arm now carries the common path.
 *  2. the `_tag` discriminant — a structurally-equal error from another copy
 *     of this package (two versions in one `node_modules` tree defeat
 *     `instanceof`).
 *  3. the printout. Effect v3 wrapped an escaping error in a `FiberFailure`
 *     whose prototype was not the error class, rendering it as
 *     `(FiberFailure) AuthExpiredError: …`; v4 removed that wrapper, but a
 *     bundle built against v3 still produces the string, and any boundary
 *     that loses the prototype and the `_tag` leaves only the printout. The
 *     match is ANCHORED to that shape (S-L2) rather than scanning the whole
 *     string for the tag name. An unanchored `includes` would classify any
 *     error whose message merely quotes the tag — including one echoing a
 *     server-supplied code — as an expiry, which is a sign-out decision taken
 *     on someone else's input.
 */
export function isAuthExpiredError(err: unknown): boolean {
  if (err instanceof AuthExpiredError) return true;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    if ((err as { _tag: unknown })._tag === "AuthExpiredError") return true;
  }
  // `String(x)` throws on a null-prototype object — there is no `toString` to
  // reach. This predicate runs inside `catch` blocks, so a throw here would
  // swap a recoverable expiry for an unhandled rejection.
  try {
    return TAGGED_ERROR_PRINTOUT.test(String(err));
  } catch {
    return false;
  }
}
