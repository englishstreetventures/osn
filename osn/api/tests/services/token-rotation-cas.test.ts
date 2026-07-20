/**
 * Direct coverage for the refresh-rotation compare-and-swap (CAS) gate in
 * `refreshTokens` (osn/api/src/services/auth/tokens.ts).
 *
 * Landed in #253, the rotation guards the "delete old session + insert new
 * session" swap with a CAS: the old-session DELETE is the atomic
 * compare-and-swap. If the DELETE reports 0 rows affected, the session was
 * already rotated out. #253 revoked the whole family here, but that was a
 * false positive: a replay of an already-rotated token can't reach this branch
 * (it fails `verifyRefreshToken`, whose row is absent, and goes down
 * `detectReuse` instead) — so a 0-rows CAS is ALWAYS a concurrent grant of the
 * *current* token (multi-tab reload, a bootstrap racing a 401-refresh, a
 * retried grant), never reuse. Revoking logged legitimate users out across
 * every device (the "logs out sometimes" bug). The branch now treats a 0-rows
 * CAS as a benign race: the losing grant fails, but the family is PRESERVED
 * (the concurrent winner's session stays valid) and no reuse metrics fire.
 *
 * The happy path and the `verifyRefreshToken` → `detectReuse` reuse path (now
 * gated by the rotation grace window) are covered in `auth.test.ts`. The
 * CAS-0-rows branch is a DIFFERENT branch: it fires when the row is PRESENT at
 * verify time but GONE by DELETE time — the concurrent-writer race. This file
 * covers it deterministically.
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

describe("refresh rotation CAS 0-rows → benign race (family preserved)", () => {
  it.effect(
    "a lost CAS (delete reports 0 rows) is a benign concurrent grant — family preserved, no reuse metrics",
    () => {
      // A dedicated rotated-session store + auth service.
      const rotatedSessionStore = createInMemoryRotatedSessionStore();
      const auth = createAuthService({ ...config, rotatedSessionStore });

      const reuseSpy = vi.spyOn(metrics, "metricSessionReuseDetected");
      const familyRevokedSpy = vi.spyOn(metrics, "metricSessionFamilyRevoked");
      const rotationRaceSpy = vi.spyOn(metrics, "metricSessionRotationRace");

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

        // Insert a SIBLING session in the same family — this stands in for the
        // session the concurrent WINNER rotated in. The benign-race path must
        // leave it untouched (whereas the old revoke-on-CAS-loss behaviour
        // would have deleted it). Its survival is the assertion that the family
        // is not revoked.
        const nowSec = Math.floor(Date.now() / 1000);
        yield* Effect.tryPromise(() =>
          realDb.insert(sessions).values({
            id: "sibling-session-hash",
            accountId: profile.accountId,
            familyId,
            expiresAt: nowSec + 3600,
            createdAt: nowSec,
            uaLabel: null,
            ipHash: null,
            lastUsedAt: nowSec,
          }),
        );

        reuseSpy.mockClear();
        familyRevokedSpy.mockClear();
        rotationRaceSpy.mockClear();

        // Arm the CAS-losing interception, then refresh. `verifyRefreshToken`
        // sees the (present) session row and passes; the rotation DELETE then
        // reports 0 rows → CAS-lost branch (a concurrent grant rotated it out).
        arm();
        const error = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));

        // 1. The losing grant is rejected (no sibling minted for it).
        expect(error._tag).toBe("AuthError");
        expect(error.message).toMatch(/Invalid or expired session/);

        // 2. The family is PRESERVED — the concurrent winner's sibling session
        //    survives (this is the false-positive-logout fix).
        const afterFamily = yield* Effect.tryPromise(() =>
          realDb.select().from(sessions).where(eq(sessions.familyId, familyId)),
        );
        expect(afterFamily.map((s) => s.id)).toContain("sibling-session-hash");

        // 3. Reuse / family-revocation metrics did NOT fire; the benign
        //    rotation-race metric did.
        expect(reuseSpy).not.toHaveBeenCalled();
        expect(familyRevokedSpy).not.toHaveBeenCalled();
        expect(rotationRaceSpy).toHaveBeenCalledTimes(1);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            reuseSpy.mockRestore();
            familyRevokedSpy.mockRestore();
            rotationRaceSpy.mockRestore();
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
