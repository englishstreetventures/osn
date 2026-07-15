/**
 * Direct coverage for the refresh-rotation compare-and-swap (CAS) gate in
 * `refreshTokens` (osn/api/src/services/auth/tokens.ts).
 *
 * Landed in #253, the rotation now guards the "delete old session + insert
 * new session" swap with a CAS: the old-session DELETE is the atomic
 * compare-and-swap. If the DELETE reports 0 rows affected, the session was
 * already rotated out (a concurrent refresh won the race, or the token is a
 * replay) — which is Copenhagen Book C2 token reuse. The correct response is
 * to revoke the WHOLE session family rather than mint a sibling session.
 *
 * The happy path and the `verifyRefreshToken` → `detectReuse` reuse path are
 * covered in `auth.test.ts`. But that reuse path fires when the session row is
 * ABSENT at verify time. The CAS-0-rows branch is a DIFFERENT branch: it fires
 * when the row is PRESENT at verify time but GONE by DELETE time — the
 * concurrent/replayed-writer race. It previously had no direct deterministic
 * test (flagged during the #253 rehab). This file adds one.
 *
 * Forcing it deterministically (no real concurrency / timing): we wrap the
 * drizzle `Db` handle in a proxy that, on the FIRST `db.delete(...)` of a
 * refresh, genuinely removes the target row (so the row really is gone, as it
 * would be after a concurrent winner rotated it) but reports `{ changes: 0 }`
 * to the caller. That is exactly the state the CAS is designed to detect, and
 * it drives `refreshTokens` down the 0-rows branch on demand.
 */

import { it, expect, describe } from "@effect/vitest";
import { sessions } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeAll, vi } from "vitest";

import { createInMemoryRotatedSessionStore } from "../../src/lib/rotated-session-store";
import * as metrics from "../../src/metrics";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Build a `Db` layer whose `db` handle behaves normally EXCEPT that the first
 * `db.delete(...)` call is intercepted: it runs the delete for real (removing
 * the row) but resolves to `{ changes: 0 }`, simulating "some other writer
 * already rotated this session out". This forces the CAS-lost branch of
 * `refreshTokens` on the next refresh, deterministically.
 *
 * We build the underlying in-memory SQLite the same way `createTestLayer()`
 * does — reusing that layer's schema by extracting its `db`, then proxying it.
 */
function makeCasLosingLayer() {
  // Borrow the fully-migrated in-memory DB from the shared helper so we don't
  // duplicate the CREATE TABLE DDL here.
  const baseLayer = createTestLayer();
  const emailLayer = makeLogEmailLive().layer;

  // Pull the real `db` out of the base layer so we can wrap it.
  const realDbService = Effect.runSync(
    Effect.provide(
      Effect.gen(function* () {
        return yield* Db;
      }),
      baseLayer,
    ),
  );
  const realDb = realDbService.db;

  // Arm the interception for exactly one `db.delete(...)` call.
  let armed = false;
  const arm = () => {
    armed = true;
  };

  const proxiedDb = new Proxy(realDb as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "delete" && typeof value === "function") {
        return (...args: unknown[]) => {
          // The real drizzle delete builder (thenable via `.where(...)`).
          const builder = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!armed) return builder;
          armed = false;
          // Wrap the builder so `.where(...)` executes the real delete (the
          // row genuinely disappears) but the awaited result reports 0 rows —
          // exactly the state a lost CAS observes.
          return new Proxy(builder as object, {
            get(bt, bprop, br) {
              const bval = Reflect.get(bt, bprop, br);
              if (bprop === "where" && typeof bval === "function") {
                return (...wargs: unknown[]) => {
                  // Run the real delete to actually remove the row, then
                  // resolve to changes: 0.
                  const inner = (bval as (...a: unknown[]) => Promise<unknown>).apply(bt, wargs);
                  return Promise.resolve(inner).then(() => ({ changes: 0, rowsAffected: 0 }));
                };
              }
              return typeof bval === "function" ? bval.bind(bt) : bval;
            },
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DbService["db"];

  const dbLayer = Layer.succeed(Db, { db: proxiedDb });
  return { layer: Layer.merge(dbLayer, emailLayer), realDb, arm };
}

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("refresh rotation CAS 0-rows → family revocation (C2)", () => {
  it.effect(
    "a lost CAS (delete reports 0 rows) revokes the whole family and fires reuse metrics",
    () => {
      // A dedicated rotated-session store + auth service so the store's
      // family-revoke path is exercised alongside the DB-level revoke.
      const rotatedSessionStore = createInMemoryRotatedSessionStore();
      const auth = createAuthService({ ...config, rotatedSessionStore });

      const reuseSpy = vi.spyOn(metrics, "metricSessionReuseDetected");
      const familyRevokedSpy = vi.spyOn(metrics, "metricSessionFamilyRevoked");

      const { layer, realDb, arm } = makeCasLosingLayer();

      return Effect.gen(function* () {
        const profile = yield* auth.registerProfile("cas@example.com", "casuser");
        const tokens = yield* auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        );

        // Confirm the family is present before the refresh.
        const before = yield* Effect.tryPromise(() =>
          realDb.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
        );
        expect(before.length).toBe(1);
        const familyId = before[0]!.familyId;

        reuseSpy.mockClear();
        familyRevokedSpy.mockClear();

        // Arm the CAS-losing interception, then refresh. `verifyRefreshToken`
        // sees the (present) session row and passes; the rotation DELETE then
        // reports 0 rows → CAS-lost branch.
        arm();
        const error = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));

        // 1. Refresh is rejected (no sibling session minted).
        expect(error._tag).toBe("AuthError");
        expect(error.message).toMatch(/Invalid or expired session/);

        // 2. The ENTIRE family is revoked — every session in the family is gone.
        const afterFamily = yield* Effect.tryPromise(() =>
          realDb.select().from(sessions).where(eq(sessions.familyId, familyId)),
        );
        expect(afterFamily.length).toBe(0);

        // And no rows leaked for the account at all.
        const afterAccount = yield* Effect.tryPromise(() =>
          realDb.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
        );
        expect(afterAccount.length).toBe(0);

        // 3. Reuse-detection metrics fired: reuse detected + family revoked.
        expect(reuseSpy).toHaveBeenCalledTimes(1);
        expect(familyRevokedSpy).toHaveBeenCalledTimes(1);

        // 4. The rotated-out hash was tracked in the store, so a subsequent
        //    replay of the (now revoked) token is still recognised as reuse.
        const reuseCallsBefore = reuseSpy.mock.calls.length;
        const replayErr = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
        expect(replayErr._tag).toBe("AuthError");
        // The store-backed detectReuse path fires reuse again on the replay.
        expect(reuseSpy.mock.calls.length).toBeGreaterThan(reuseCallsBefore);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            reuseSpy.mockRestore();
            familyRevokedSpy.mockRestore();
          }),
        ),
      );
    },
  );

  // Control: with the interception NOT armed, the proxied layer is fully
  // transparent and a refresh rotates normally. This proves the CAS branch in
  // the test above is triggered by the forced 0-rows delete — not by a broken
  // proxy layer producing spurious failures.
  it.effect("control: un-armed proxy layer rotates normally (no family revoke)", () => {
    const auth = createAuthService(config);
    const reuseSpy = vi.spyOn(metrics, "metricSessionReuseDetected");
    const familyRevokedSpy = vi.spyOn(metrics, "metricSessionFamilyRevoked");
    const { layer, realDb } = makeCasLosingLayer(); // note: `arm()` never called

    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("cas-ok@example.com", "casok");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      reuseSpy.mockClear();
      familyRevokedSpy.mockClear();

      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);

      // Exactly one live session for the account (rotated, not revoked).
      const after = yield* Effect.tryPromise(() =>
        realDb.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
      );
      expect(after.length).toBe(1);

      expect(reuseSpy).not.toHaveBeenCalled();
      expect(familyRevokedSpy).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          reuseSpy.mockRestore();
          familyRevokedSpy.mockRestore();
        }),
      ),
    );
  });
});
