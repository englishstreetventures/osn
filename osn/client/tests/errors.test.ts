import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuthExpiredError, isAuthExpiredError, TokenRefreshError } from "../src/errors";

/**
 * This predicate exists because the error reaching a consumer's `catch` is not
 * reliably the class. These pin each arm — including the escape from a real
 * Effect, produced here rather than hand-written, so an Effect upgrade that
 * changes the rejection shape fails this test instead of a consumer's
 * redirect.
 */
describe("isAuthExpiredError", () => {
  it("accepts the unwrapped error", () => {
    expect(isAuthExpiredError(new AuthExpiredError({}))).toBe(true);
  });

  it("accepts a structurally-equal error from another copy of the package", () => {
    expect(isAuthExpiredError({ _tag: "AuthExpiredError" })).toBe(true);
  });

  it("accepts the error as it escapes an Effect", async () => {
    const escaped = await Effect.runPromise(Effect.fail(new AuthExpiredError({}))).then(
      () => null,
      (err: unknown) => err,
    );
    // Effect v4 rejects with `Cause.squash(cause)` — for a typed failure that
    // is the error itself, where v3 handed back a `FiberFailure` wrapper whose
    // prototype was not the error class. Pinned so a future change back to a
    // wrapper is caught here.
    expect(escaped).toBeInstanceOf(AuthExpiredError);
    expect(isAuthExpiredError(escaped)).toBe(true);
  });

  // v4 no longer produces this string, but a consumer bundle built against v3
  // still can, and it is the only arm left once a boundary has stripped both
  // the prototype and the `_tag`.
  it("still accepts a v3 FiberFailure printout", () => {
    expect(
      isAuthExpiredError({
        toString: () => "(FiberFailure) AuthExpiredError: Your session has expired.",
      }),
    ).toBe(true);
  });

  it("rejects a sibling client error", () => {
    expect(isAuthExpiredError(new TokenRefreshError({ cause: "boom" }))).toBe(false);
  });

  // S-L2: the printout arm is anchored to the tag heading the string, so a
  // message that merely quotes it is not an expiry. Consumers catch errors
  // whose message is a server-supplied code; an unanchored `includes` would
  // let that string decide to sign someone out.
  it("rejects an error that merely quotes the tag in its message", () => {
    expect(isAuthExpiredError(new Error("ApiError: AuthExpiredError"))).toBe(false);
    expect(isAuthExpiredError("the server said AuthExpiredError")).toBe(false);
    expect(isAuthExpiredError({ error: "AuthExpiredError" })).toBe(false);
  });

  it("rejects an unrelated failure", () => {
    expect(isAuthExpiredError(new Error("Network request failed"))).toBe(false);
    expect(isAuthExpiredError({ _tag: "StorageError" })).toBe(false);
  });

  it("returns false rather than throwing on values with no string form", () => {
    // `String(Object.create(null))` throws — and this runs inside `catch`.
    expect(isAuthExpiredError(Object.create(null))).toBe(false);
    expect(isAuthExpiredError(null)).toBe(false);
    expect(isAuthExpiredError(undefined)).toBe(false);
  });
});
