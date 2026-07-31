import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuthExpiredError, isAuthExpiredError, TokenRefreshError } from "../src/errors";

/**
 * The whole reason this predicate exists is that `instanceof` does not survive
 * the trip out of an Effect. These pin each arm — including the real
 * FiberFailure, produced here rather than hand-written, so an Effect upgrade
 * that changes the printout fails this test instead of a consumer's redirect.
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
    // The premise of the finding: the wrapper is not the error class.
    expect(escaped instanceof AuthExpiredError).toBe(false);
    expect(isAuthExpiredError(escaped)).toBe(true);
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
