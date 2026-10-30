/**
 * Direct coverage for the refresh-rotation compare-and-swap (CAS) gate in
 * `refreshTokens` (osn/api/src/services/auth/tokens.ts).
 *
 * A rotation writes the new session (only while the old one stands), then the
 * record of the old token, then deletes the old session (only while the new
 * one stands). That delete is the compare-and-swap. If it reports 0 rows, the
 * session was rotated by a concurrent grant of the *current* token (multi-tab
 * reload, a bootstrap racing a 401-refresh, a retried grant), or a revoke took
 * the family mid-grant — never reuse: a replay of an already-rotated token
 * fails `verifyRefreshToken`, whose row is absent, and goes down `detectReuse`
 * instead. The losing grant fails and removes what it wrote; the family is
 * PRESERVED (a concurrent winner's session stays valid) and no reuse metrics
 * fire.
 *
 * The happy path and the `verifyRefreshToken` → `detectReuse` reuse path
 * (gated by the rotation grace window) are covered in `auth.test.ts`. The
 * CAS-0-rows branch fires when the row is PRESENT at verify time but GONE by
 * the swap — the concurrent-writer race. This file covers it deterministically,
 * two ways: a proxy whose FIRST `db.delete(...)` of a refresh genuinely removes
 * the row but reports `{ changes: 0 }`, and the held-statement seam, which lands
 * a real request between two of the rotation's statements.
 */

import { it, expect, describe } from "@effect/vitest";
import { rotatedSessions, sessions } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { beforeAll, vi } from "vitest";

import { ROTATION_RACE_MESSAGE } from "../../src/lib/grant-failure";
import * as metrics from "../../src/metrics";
import { createAuthService } from "../../src/services/auth";
import { ROTATION_GRACE_MS } from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

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
function makeDeleteInterceptingLayer(
  /**
   * Rewrites the awaited result of an intercepted `db.delete(...)`. The real
   * delete still runs — only what the caller reads back changes. `real` is the
   * driver's own result (bun:sqlite's `{ changes }`).
   */
  reshape: (real: unknown) => unknown,
  /** `"once"` intercepts only after `arm()`; `"always"` reshapes every delete. */
  when: "once" | "always" = "once",
) {
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
  let armed = when === "always";
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
          if (when === "once") armed = false;
          // Wrap the builder so `.where(...)` executes the real delete (the
          // row genuinely disappears) but the awaited result is reshaped —
          // either to 0 rows (a lost CAS) or to another driver's shape.
          return new Proxy(builder as object, {
            get(bt, bprop, br) {
              const bval = Reflect.get(bt, bprop, br);
              if (bprop === "where" && typeof bval === "function") {
                return (...wargs: unknown[]) => {
                  // Run the real delete, then hand back the reshaped result.
                  const inner = (bval as (...a: unknown[]) => Promise<unknown>).apply(bt, wargs);
                  return Promise.resolve(inner).then(reshape);
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

/** One delete reports 0 rows affected while genuinely removing the row. */
const makeCasLosingLayer = () =>
  makeDeleteInterceptingLayer(() => ({ changes: 0, rowsAffected: 0 }));

/**
 * Every delete reports its count the way Cloudflare D1 does — under
 * `meta.changes`, with no top-level `changes` / `rowsAffected` at all. Tests
 * run on bun:sqlite, production runs on D1, so without this the CAS gate can
 * read `undefined ?? 0` in production and stay green here. It did: every
 * production refresh deleted its session, skipped the insert, and returned
 * `invalid_grant`.
 */
const makeD1ShapedLayer = () =>
  makeDeleteInterceptingLayer(
    (real) => ({
      success: true,
      meta: { changes: (real as { changes?: number }).changes ?? 0, duration: 0.1 },
      results: [],
    }),
    "always",
  );

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("refresh rotation CAS 0-rows → benign race (family preserved)", () => {
  it.effect(
    "a lost CAS (delete reports 0 rows) is a benign concurrent grant — family preserved, no reuse metrics",
    () => {
      const auth = createAuthService(config);

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
        // Distinct from the "token does not verify" message on purpose: the
        // route reads it to decide NOT to retract the session marker, because
        // the winning grant's cookie is alive.
        expect(error.message).toBe(ROTATION_RACE_MESSAGE);

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

  // Regression: the CAS must read D1's rows-affected shape. On D1 the delete
  // result carries its count under `meta.changes`; a reader that only knows
  // `changes` / `rowsAffected` sees `undefined` and treats every successful
  // rotation as a lost race — deleting the session and failing the grant.
  it.effect("reads D1's `meta.changes` shape — a real rotation is not mistaken for a race", () => {
    const auth = createAuthService(config);
    const rotationRaceSpy = vi.spyOn(metrics, "metricSessionRotationRace");
    const { layer, realDb } = makeD1ShapedLayer();

    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("d1-shape@example.com", "d1shape");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      rotationRaceSpy.mockClear();

      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);

      // The rotation swapped one row for another — it did not leave the
      // account session-less.
      const after = yield* Effect.tryPromise(() =>
        realDb.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
      );
      expect(after.length).toBe(1);

      // And it was never counted as a race.
      expect(rotationRaceSpy).not.toHaveBeenCalled();

      // The new refresh token works too — proving the swap left a usable
      // session, not just any row.
      const again = yield* auth.refreshTokens(refreshed.refreshToken);
      expect(again.refreshToken).not.toBe(refreshed.refreshToken);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rotationRaceSpy.mockRestore())),
    );
  });
});

describe("a rotation and the requests that land between its statements", () => {
  function held() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
      hold: queries.hold,
      db,
      familyIds: (familyId: string) =>
        (
          sqlite.query("SELECT id FROM sessions WHERE family_id = ?").all(familyId) as {
            id: string;
          }[]
        ).map((row) => row.id),
    };
  }

  const signIn = (auth: ReturnType<typeof createAuthService>, email: string, handle: string) =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile(email, handle);
      const { refreshToken } = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const { familyId } = yield* auth.verifyRefreshToken(refreshToken);
      return { profile, refreshToken, familyId };
    });

  it.live("a replay's family revoke that lands while a refresh is held leaves no session", () => {
    const auth = createAuthService(config);
    const h = held();
    return Effect.gen(function* () {
      const { refreshToken: t0, familyId } = yield* signIn(auth, "fr-f1@example.com", "frf1");
      const t1 = (yield* auth.refreshTokens(t0)).refreshToken;

      const insert = h.hold(/^insert into "sessions"/);
      const refresh = yield* Effect.forkChild(Effect.result(auth.refreshTokens(t1)));
      yield* Effect.promise(() => insert.reached);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + ROTATION_GRACE_MS + 1_000);
      // t0 was rotated out more than the grace window ago: reuse, the family goes.
      yield* Effect.result(auth.refreshTokens(t0));
      clock.mockRestore();
      insert.release();

      expect((yield* Fiber.join(refresh))._tag).toBe("Failure");
      expect(h.familyIds(familyId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("of two grants of one token interleaved, one stands and the other leaves nothing", () => {
    const auth = createAuthService(config);
    const h = held();
    return Effect.gen(function* () {
      const { refreshToken, familyId } = yield* signIn(auth, "fr-f2@example.com", "frf2");

      const swap = h.hold(/^delete from "sessions"/);
      const first = yield* Effect.forkChild(Effect.result(auth.refreshTokens(refreshToken)));
      yield* Effect.promise(() => swap.reached);
      const second = yield* Effect.result(auth.refreshTokens(refreshToken));
      swap.release();
      const outcomes = [yield* Fiber.join(first), second];

      const won = outcomes.filter((o) => o._tag === "Success");
      expect(won).toHaveLength(1);
      const standing = won[0]!._tag === "Success" ? won[0]!.success.refreshToken : "";
      expect(h.familyIds(familyId)).toEqual([auth.hashSessionToken(standing)]);
      yield* auth.verifyRefreshToken(standing);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a grant that loses its new row to a wipe leaves the old token able to rotate", () => {
    const auth = createAuthService(config);
    const h = held();
    return Effect.gen(function* () {
      const { profile, refreshToken, familyId } = yield* signIn(auth, "fr-f3@example.com", "frf3");
      const oldHash = auth.hashSessionToken(refreshToken);

      const swap = h.hold(/^delete from "sessions"/);
      const lost = yield* Effect.forkChild(Effect.result(auth.refreshTokens(refreshToken)));
      yield* Effect.promise(() => swap.reached);
      // Every session but the old one goes, the new row with them.
      yield* auth.invalidateOtherAccountSessions(profile.accountId, oldHash);
      swap.release();

      const outcome = yield* Fiber.join(lost);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.message).toBe(ROTATION_RACE_MESSAGE);
      expect(h.familyIds(familyId)).toEqual([oldHash]);
      const records = yield* Effect.promise(() =>
        h.db.select().from(rotatedSessions).where(eq(rotatedSessions.tokenHash, oldHash)),
      );
      expect(records).toEqual([]);

      // The device's next grant rotates the token it still holds.
      const startedAt = Date.now();
      const next = yield* auth.refreshTokens(refreshToken);
      yield* auth.verifyRefreshToken(next.refreshToken);
      const [record] = yield* Effect.promise(() =>
        h.db.select().from(rotatedSessions).where(eq(rotatedSessions.tokenHash, oldHash)),
      );
      expect(record!.rotatedAt).toBeGreaterThanOrEqual(startedAt);
    }).pipe(Effect.provide(h.layer));
  });
});
