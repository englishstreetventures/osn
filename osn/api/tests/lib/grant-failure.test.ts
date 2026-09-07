import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ROTATION_RACE_MESSAGE, sessionStatusUnknown } from "../../src/lib/grant-failure";
import { makeAppRunner } from "../../src/lib/route-runtime";
import { AuthError, DatabaseError } from "../../src/services/auth/errors";

/**
 * S-M2. The marker is a cache of "a session cookie exists in this browser", and
 * `POST /token` retracting it is the only thing a fresh tab with no local
 * account state consults. So the predicate below decides whether a browser
 * holding a live 30-day cookie stays signed in or is stranded signed out.
 *
 * Route handlers run effects through `makeAppRunner`'s `run`, so that is what
 * these tests go through — not a raw `runtime.runPromise`, which is a path no
 * route takes and which (Effect v4 having replaced `FiberFailure` with a
 * squashed cause) would hand a DEFECT to the predicate dressed as a typed
 * failure. Both the runner's shape and a bare tagged error are pinned here.
 */

const { run } = makeAppRunner(undefined, Layer.empty);

/** Produce the failure exactly as the route's `catch` sees it. */
async function asRouteCatches(error: unknown): Promise<unknown> {
  try {
    await run(Effect.fail(error) as Effect.Effect<never, unknown>);
  } catch (e) {
    return e;
  }
  throw new Error("expected the effect to fail");
}

/** Produce the same error as a DEFECT — `die`d rather than `fail`ed. */
async function asRouteCatchesDefect(error: unknown): Promise<unknown> {
  try {
    await run(Effect.die(error));
  } catch (e) {
    return e;
  }
  throw new Error("expected the effect to die");
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

  it("reads a bare tagged error too, not only one that came through the runner", async () => {
    // Cheap insurance: the route's runner shape is not this module's business.
    expect(sessionStatusUnknown(new DatabaseError({ cause: "down" }))).toBe(true);
    expect(sessionStatusUnknown(new AuthError({ message: ROTATION_RACE_MESSAGE }))).toBe(true);
    expect(sessionStatusUnknown(new AuthError({ message: "Invalid or expired session" }))).toBe(
      false,
    );
  });

  /**
   * A `Data.TaggedError` is an `Error` with a `_tag`, so a DEFECT looks exactly
   * like a typed failure once a plain `runPromise` has squashed the cause. The
   * runner's `Fail`/defect split is what stops one answering this predicate: a
   * crash somewhere under `POST /token` is not evidence about the cookie, and
   * must fall through to the retracting default rather than pin the marker up.
   */
  describe("a DEFECT is not evidence, whatever tag it carries", () => {
    it("a died DatabaseError does not keep the marker", async () => {
      expect(
        sessionStatusUnknown(await asRouteCatchesDefect(new DatabaseError({ cause: "down" }))),
      ).toBe(false);
    });

    it("a died rotation-race AuthError does not keep the marker", async () => {
      expect(
        sessionStatusUnknown(
          await asRouteCatchesDefect(new AuthError({ message: ROTATION_RACE_MESSAGE })),
        ),
      ).toBe(false);
    });

    it("but the SAME errors raised as typed failures still keep it", async () => {
      // The control: without it, the two cases above are satisfied by a
      // predicate that answers `false` for everything.
      expect(sessionStatusUnknown(await asRouteCatches(new DatabaseError({ cause: "down" })))).toBe(
        true,
      );
      expect(
        sessionStatusUnknown(
          await asRouteCatches(new AuthError({ message: ROTATION_RACE_MESSAGE })),
        ),
      ).toBe(true);
    });
  });
});
