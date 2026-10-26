import { it, expect, describe } from "@effect/vitest";
import { rotatedSessions, sessions } from "@osn/db/schema";
import { and, eq, lte } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { sessionStatusUnknown } from "../../../src/lib/grant-failure";
import * as metrics from "../../../src/metrics";
import { createAuthService } from "../../../src/services/auth";
import {
  ROTATED_SESSION_SWEEP_CHUNK,
  ROTATED_SESSION_SWEEP_MAX_CHUNKS,
  ROTATION_GRACE_MS,
} from "../../../src/services/auth/constants";
import { hashSessionToken } from "../../../src/services/auth/helpers";
import { runRotatedSessionSweep } from "../../../src/services/auth/tokens";
import { makeTestAuthConfig } from "../../helpers/auth-config";
import { createTestLayerWithSqlite } from "../../helpers/db";

/**
 * Rotated-session reuse detection on the `rotated_sessions` table: the record
 * a rotation writes, what a replay of a rotated-out token does with it, how a
 * failure to write or read it surfaces, and the sweep that clears it.
 *
 * bun:sqlite runs `commitBatch` statement by statement, so whether the two
 * inserts of a rotation commit together is proven on real D1 in
 * `tests/d1/rotated-sessions.test.ts`, not here.
 */

let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  auth = createAuthService(await makeTestAuthConfig());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REFRESH_TTL_MS = 2_592_000 * 1000;

/** Registers an account and opens one session on it. */
const signIn = (email: string, handle: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.registerProfile(email, handle);
    const tokens = yield* auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
    );
    return { profile, refreshToken: tokens.refreshToken };
  });

describe("refreshTokens: the rotation record", () => {
  it.effect("writes one row for the rotated-out token, in its family, for a refresh TTL", () => {
    const { layer, db } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile, refreshToken } = yield* signIn("record@example.com", "record");
      const [before] = yield* Effect.promise(() =>
        db.select().from(sessions).where(eq(sessions.accountId, profile.accountId)),
      );
      const startedAt = Date.now();

      yield* auth.refreshTokens(refreshToken);

      const rows = yield* Effect.promise(() => db.select().from(rotatedSessions));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tokenHash: hashSessionToken(refreshToken),
        familyId: before!.familyId,
        accountId: profile.accountId,
      });
      expect(rows[0]!.rotatedAt).toBeGreaterThanOrEqual(startedAt);
      expect(rows[0]!.expiresAt - rows[0]!.rotatedAt).toBe(REFRESH_TTL_MS);
    }).pipe(Effect.provide(layer));
  });

  // F-SV1
  it.effect(
    "fails with a DatabaseError, which leaves the session marker up, when the write fails",
    () => {
      const { layer, db } = createTestLayerWithSqlite();
      return Effect.gen(function* () {
        const { profile, refreshToken } = yield* signIn("write-fail@example.com", "writefail");
        // A row already holding this token's hash makes the rotation's own
        // insert fail on the primary key.
        yield* Effect.promise(() =>
          db.insert(rotatedSessions).values({
            tokenHash: hashSessionToken(refreshToken),
            familyId: "sfam_other",
            accountId: profile.accountId,
            rotatedAt: 0,
            expiresAt: Date.now() + 60_000,
          }),
        );

        const error = yield* Effect.flip(auth.refreshTokens(refreshToken));

        expect(error._tag).toBe("DatabaseError");
        expect(sessionStatusUnknown(error)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("refreshTokens: a replayed rotated-out token", () => {
  it.effect("outside the grace window revokes the family and its rotation records", () => {
    const { layer, db } = createTestLayerWithSqlite();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    const revoked = vi.spyOn(metrics, "metricSessionFamilyRevoked");
    return Effect.gen(function* () {
      const { profile, refreshToken: t0 } = yield* signIn("reuse@example.com", "reuse");
      const t1 = (yield* auth.refreshTokens(t0)).refreshToken;
      const t2 = (yield* auth.refreshTokens(t1)).refreshToken;
      yield* Effect.promise(() =>
        db.update(rotatedSessions).set({ rotatedAt: Date.now() - ROTATION_GRACE_MS - 1 }),
      );

      const error = yield* Effect.flip(auth.refreshTokens(t0));

      expect(error._tag).toBe("AuthError");
      expect(error.message).toBe("Invalid or expired session");
      const live = yield* Effect.flip(auth.verifyRefreshToken(t2));
      expect(live._tag).toBe("AuthError");
      const left = yield* Effect.promise(() =>
        db.select().from(rotatedSessions).where(eq(rotatedSessions.accountId, profile.accountId)),
      );
      expect(left).toEqual([]);
      expect(reuse).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("revokes only its own family", () => {
    const { layer, db } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile, refreshToken: a0 } = yield* signIn("two-fam@example.com", "twofam");
      const b0 = (yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )).refreshToken;
      yield* auth.refreshTokens(a0);
      const b1 = (yield* auth.refreshTokens(b0)).refreshToken;
      yield* Effect.promise(() => db.update(rotatedSessions).set({ rotatedAt: 0 }));

      yield* Effect.flip(auth.refreshTokens(a0));

      const stillLive = yield* auth.verifyRefreshToken(b1);
      expect(stillLive.accountId).toBe(profile.accountId);
      const left = yield* Effect.promise(() => db.select().from(rotatedSessions));
      expect(left.map((r) => r.tokenHash)).toEqual([hashSessionToken(b0)]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is not reuse once its record has expired", () => {
    const { layer, db } = createTestLayerWithSqlite();
    const reuse = vi.spyOn(metrics, "metricSessionReuseDetected");
    return Effect.gen(function* () {
      const { refreshToken: t0 } = yield* signIn("expired-rec@example.com", "expiredrec");
      const t1 = (yield* auth.refreshTokens(t0)).refreshToken;
      yield* Effect.promise(() =>
        db.update(rotatedSessions).set({ rotatedAt: 0, expiresAt: Date.now() - 1 }),
      );

      const error = yield* Effect.flip(auth.refreshTokens(t0));

      expect(error._tag).toBe("AuthError");
      const live = yield* auth.verifyRefreshToken(t1);
      expect(live.familyId).toBeTruthy();
      expect(reuse).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  // F-SV2
  it.effect("fails with a DatabaseError and revokes nothing when the record cannot be read", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    const revoked = vi.spyOn(metrics, "metricSessionFamilyRevoked");
    return Effect.gen(function* () {
      const { refreshToken: t0 } = yield* signIn("read-fail@example.com", "readfail");
      const t1 = (yield* auth.refreshTokens(t0)).refreshToken;
      sqlite.run("DROP TABLE rotated_sessions");

      const error = yield* Effect.flip(auth.refreshTokens(t0));

      expect(error._tag).toBe("DatabaseError");
      const live = yield* auth.verifyRefreshToken(t1);
      expect(live.familyId).toBeTruthy();
      expect(revoked).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });
});

describe("runRotatedSessionSweep", () => {
  /** Inserts `count` rotation records for one account, all expiring at `expiresAt`. */
  const seed = (
    sqlite: ReturnType<typeof createTestLayerWithSqlite>["sqlite"],
    accountId: string,
    prefix: string,
    count: number,
    expiresAt: number,
  ) =>
    sqlite.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO rotated_sessions (token_hash, family_id, account_id, rotated_at, expires_at)
       SELECT ? || i, 'sfam_seed', ?, 0, ? FROM n`,
      [count, prefix, accountId, expiresAt],
    );

  it.effect("deletes expired records and keeps live ones", () => {
    const { layer, db, sqlite } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const { profile } = yield* signIn("sweep@example.com", "sweep");
      const nowMs = 1_000_000;
      seed(sqlite, profile.accountId, "dead_", 3, nowMs - 1);
      seed(sqlite, profile.accountId, "edge_", 1, nowMs);
      seed(sqlite, profile.accountId, "live_", 2, nowMs + 1);

      const result = yield* runRotatedSessionSweep({ nowMs });

      expect(result.deleted).toBe(4);
      const left = yield* Effect.promise(() => db.select().from(rotatedSessions));
      expect(left.map((r) => r.tokenHash).toSorted()).toEqual(["live_1", "live_2"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes at most its chunk limit per run, and the rest on the next", () => {
    const { layer, db, sqlite } = createTestLayerWithSqlite();
    const cap = ROTATED_SESSION_SWEEP_CHUNK * ROTATED_SESSION_SWEEP_MAX_CHUNKS;
    return Effect.gen(function* () {
      const { profile } = yield* signIn("sweep-cap@example.com", "sweepcap");
      const nowMs = 1_000_000;
      seed(sqlite, profile.accountId, "dead_", cap + 200, nowMs - 1);
      seed(sqlite, profile.accountId, "live_", 1, nowMs + 1);

      expect((yield* runRotatedSessionSweep({ nowMs })).deleted).toBe(cap);
      const expiredLeft = yield* Effect.promise(() =>
        db.select().from(rotatedSessions).where(lte(rotatedSessions.expiresAt, nowMs)),
      );
      expect(expiredLeft).toHaveLength(200);

      expect((yield* runRotatedSessionSweep({ nowMs })).deleted).toBe(200);
      const left = yield* Effect.promise(() =>
        db
          .select()
          .from(rotatedSessions)
          .where(and(eq(rotatedSessions.accountId, profile.accountId))),
      );
      expect(left.map((r) => r.tokenHash)).toEqual(["live_1"]);
    }).pipe(Effect.provide(layer));
  });
});
