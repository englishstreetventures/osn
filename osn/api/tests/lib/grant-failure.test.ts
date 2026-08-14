import { Effect, ManagedRuntime, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ROTATION_RACE_MESSAGE, sessionStatusUnknown } from "../../src/lib/grant-failure";
import { AuthError, DatabaseError } from "../../src/services/auth/errors";

/**
 * S-M2. The marker is a cache of "a session cookie exists in this browser", and
 * `POST /token` retracting it is the only thing a fresh tab with no local
 * account state consults. So the predicate below decides whether a browser
 * holding a live 30-day cookie stays signed in or is stranded signed out.
 *
 * Route handlers run effects through a `ManagedRuntime`, which rejects with a
 * `FiberFailure` wrapping the typed failure — never the tagged error itself.
 * A predicate that only handled the bare error would silently answer `false`
 * for every real request, so both shapes are pinned here.
 */

const runtime = ManagedRuntime.make(Layer.empty);

/** Produce the failure exactly as the route's `catch` sees it. */
async function asRouteCatches(error: unknown): Promise<unknown> {
  try {
    await runtime.runPromise(Effect.fail(error) as Effect.Effect<never, unknown>);
    throw new Error("expected the effect to fail");
  } catch (e) {
    return e;
  }
}

describe("sessionStatusUnknown", () => {
  it("keeps the marker when the DB failed", async () => {
    // A storage blip is evidence about the request, not about the cookie.
    // Retracting here converts one bad minute into a permanent logout.
    expect(sessionStatusUnknown(await asRouteCatches(new DatabaseError({ cause: "down" })))).toBe(
      true,
    );
  });

  it("keeps the marker on the benign concurrent-rotation race", async () => {
    // PR #289: two tabs grant the same token, the loser's CAS finds 0 rows.
    // The winner already set a fresh cookie — this browser is signed in.
    const failure = await asRouteCatches(new AuthError({ message: ROTATION_RACE_MESSAGE }));

    expect(sessionStatusUnknown(failure)).toBe(true);
  });

  it("retracts the marker when the token genuinely did not verify", async () => {
    // The cookie really is gone/expired/revoked. The marker is now a lie and
    // would re-arm this same doomed grant on every page load.
    const failure = await asRouteCatches(new AuthError({ message: "Invalid or expired session" }));

    expect(sessionStatusUnknown(failure)).toBe(false);
  });

  it("retracts on an unrecognised failure", async () => {
    // Fail toward retraction: a wrongly-retracted marker costs one sign-in and
    // heals, a wrongly-kept one costs a request on every load forever.
    expect(sessionStatusUnknown(await asRouteCatches(new Error("boom")))).toBe(false);
    expect(sessionStatusUnknown("not an error at all")).toBe(false);
  });

  it("reads a bare tagged error too, not only a FiberFailure", async () => {
    // Cheap insurance: the route's runner shape is not this module's business.
    expect(sessionStatusUnknown(new DatabaseError({ cause: "down" }))).toBe(true);
    expect(sessionStatusUnknown(new AuthError({ message: ROTATION_RACE_MESSAGE }))).toBe(true);
    expect(sessionStatusUnknown(new AuthError({ message: "Invalid or expired session" }))).toBe(
      false,
    );
  });
});
