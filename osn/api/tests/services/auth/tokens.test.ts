import { it, expect, describe } from "@effect/vitest";
import { rotatedSessions, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, lte } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeAll, vi } from "vitest";

import { sessionStatusUnknown } from "../../../src/lib/grant-failure";
import * as metrics from "../../../src/metrics";
import { createAuthService } from "../../../src/services/auth";
import {
  ROTATED_SESSION_SWEEP_CHUNK,
  ROTATED_SESSION_SWEEP_MAX_CHUNKS,
  ROTATED_SESSION_SWEEP_PAUSE_MS,
  ROTATION_GRACE_MS,
} from "../../../src/services/auth/constants";
import { hashSessionToken } from "../../../src/services/auth/helpers";
import { runRotatedSessionSweep } from "../../../src/services/auth/tokens";
import { makeTestAuthConfig } from "../../helpers/auth-config";
import { createCapturingTestLayer, createTestLayerWithSqlite } from "../../helpers/db";
import { holdQueries } from "../../helpers/held-query";

/**
 * Rotated-session reuse detection on the `rotated_sessions` table: the record
 * a rotation writes, what a replay of a rotated-out token does with it, how a
 * failure to write or read it surfaces, and the sweep that clears it — in
 * chunks, pausing between them, counted on the `osn.retention.*` metrics.
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

  it.effect("searches an index for every statement it sends to rotated_sessions", () => {
    const { layer, db, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const { refreshToken: t0 } = yield* signIn("plan@example.com", "plan");
      const t1 = (yield* auth.refreshTokens(t0)).refreshToken;
      yield* auth.refreshTokens(t1);
      yield* Effect.promise(() => db.update(rotatedSessions).set({ rotatedAt: 0 }));
      captured.length = 0;

      yield* Effect.flip(auth.refreshTokens(t0));

      const onTable = captured.filter(
        (s) => /"rotated_sessions"/.test(s.sql) && /^\s*(select|delete)/i.test(s.sql),
      );
      // The record read, then the family's records deleted.
      expect(onTable.map((s) => s.sql.trim().split(/\s+/)[0]!.toLowerCase())).toEqual([
        "select",
        "delete",
      ]);
      for (const { sql, params } of onTable) {
        const plan = db.$client
          .query(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(params as never[])) as Array<{ detail: string }>;
        const details = plan.map((row) => row.detail);
        expect(details.some((d) => d.startsWith("SEARCH rotated_sessions USING"))).toBe(true);
        expect(details.filter((d) => /^SCAN rotated_sessions\b/.test(d))).toEqual([]);
      }
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

  /** Rows left in `rotated_sessions`, or -1 once the table is gone. */
  const rowsLeft = (sqlite: ReturnType<typeof createTestLayerWithSqlite>["sqlite"]): number => {
    try {
      return (sqlite.query("SELECT COUNT(*) AS n FROM rotated_sessions").get() as { n: number }).n;
    } catch {
      return -1;
    }
  };

  /** Waits on the real clock until `done` holds, for at most two seconds. */
  const until = (done: () => boolean) =>
    Effect.promise(async () => {
      for (let i = 0; i < 200 && !done(); i++) {
        // eslint-disable-next-line no-await-in-loop -- polling, one wait at a time
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

  /** Long enough on the real clock for the sweep to reach its next pause. */
  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)));

  /**
   * Runs one sweep on the test clock. Each time the sweep stops deleting and
   * waits, the clock moves on by one pause, and the pause is counted; a sweep
   * that waited without needing to (after its last chunk) is counted too.
   * `atPauseEnd` runs just before each pause ends.
   */
  const sweepCountingPauses = (
    sqlite: ReturnType<typeof createTestLayerWithSqlite>["sqlite"],
    nowMs: number,
    atPauseEnd: () => void = () => {},
  ) =>
    Effect.gen(function* () {
      let finished = false;
      const fiber = yield* Effect.forkChild(
        runRotatedSessionSweep({ nowMs }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      let pauses = 0;
      let seen = rowsLeft(sqlite);
      for (;;) {
        yield* until(() => finished || rowsLeft(sqlite) !== seen);
        yield* settle;
        if (finished) break;
        seen = rowsLeft(sqlite);
        // Nothing more is deleted until the pause has passed.
        yield* TestClock.adjust(ROTATED_SESSION_SWEEP_PAUSE_MS - 1);
        yield* settle;
        expect(rowsLeft(sqlite)).toBe(seen);
        expect(finished).toBe(false);
        atPauseEnd();
        yield* TestClock.adjust(1);
        pauses++;
      }
      return { exit: yield* Fiber.await(fiber), pauses };
    });

  it.effect("deletes at most its chunk limit per run, and the rest on the next", () => {
    const { layer, db, sqlite } = createTestLayerWithSqlite();
    const cap = ROTATED_SESSION_SWEEP_CHUNK * ROTATED_SESSION_SWEEP_MAX_CHUNKS;
    return Effect.gen(function* () {
      const { profile } = yield* signIn("sweep-cap@example.com", "sweepcap");
      const nowMs = 1_000_000;
      seed(sqlite, profile.accountId, "dead_", cap + 200, nowMs - 1);
      seed(sqlite, profile.accountId, "live_", 1, nowMs + 1);

      const first = yield* sweepCountingPauses(sqlite, nowMs);
      expect(first.exit).toMatchObject({ _tag: "Success", value: { deleted: cap } });
      // One pause between each two chunks, none after the tenth.
      expect(first.pauses).toBe(ROTATED_SESSION_SWEEP_MAX_CHUNKS - 1);
      const expiredLeft = yield* Effect.promise(() =>
        db.select().from(rotatedSessions).where(lte(rotatedSessions.expiresAt, nowMs)),
      );
      expect(expiredLeft).toHaveLength(200);

      // A short chunk is the last: no pause after it.
      const second = yield* sweepCountingPauses(sqlite, nowMs);
      expect(second.exit).toMatchObject({ _tag: "Success", value: { deleted: 200 } });
      expect(second.pauses).toBe(0);
      const left = yield* Effect.promise(() =>
        db
          .select()
          .from(rotatedSessions)
          .where(and(eq(rotatedSessions.accountId, profile.accountId))),
      );
      expect(left.map((r) => r.tokenHash)).toEqual(["live_1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("counts each pass's deleted rows and its time, pauses included, by table", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    const recorded = vi.spyOn(metrics, "metricRetentionSweep");
    return Effect.gen(function* () {
      const { profile } = yield* signIn("sweep-metric@example.com", "sweepmetric");
      const nowMs = 1_000_000;
      seed(sqlite, profile.accountId, "dead_", 2 * ROTATED_SESSION_SWEEP_CHUNK + 1, nowMs - 1);

      const { exit, pauses } = yield* sweepCountingPauses(sqlite, nowMs);

      expect(exit._tag).toBe("Success");
      expect(pauses).toBe(2);
      expect(recorded.mock.calls).toEqual([
        [
          "rotated_sessions",
          2 * ROTATED_SESSION_SWEEP_CHUNK + 1,
          (2 * ROTATED_SESSION_SWEEP_PAUSE_MS) / 1000,
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still counts the rows earlier chunks deleted when a later chunk fails", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    const recorded = vi.spyOn(metrics, "metricRetentionSweep");
    return Effect.gen(function* () {
      const { profile } = yield* signIn("sweep-fail@example.com", "sweepfail");
      const nowMs = 1_000_000;
      seed(sqlite, profile.accountId, "dead_", 2 * ROTATED_SESSION_SWEEP_CHUNK, nowMs - 1);

      // The table goes away during the first pause, so the second chunk fails.
      const { exit } = yield* sweepCountingPauses(sqlite, nowMs, () =>
        sqlite.run("DROP TABLE rotated_sessions"),
      );

      expect(exit).toMatchObject({ _tag: "Failure" });
      expect(JSON.stringify(exit)).toContain("DatabaseError");
      expect(recorded.mock.calls).toEqual([
        ["rotated_sessions", ROTATED_SESSION_SWEEP_CHUNK, ROTATED_SESSION_SWEEP_PAUSE_MS / 1000],
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("verifyRefreshToken: an expired session's delete", () => {
  it.live("leaves a session that another verify of the token extended since", () => {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    const layer = Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer);
    const expiryOf = (id: string) =>
      (
        sqlite.query("SELECT expires_at AS expiresAt FROM sessions WHERE id = ?").get(id) as {
          expiresAt: number;
        } | null
      )?.expiresAt;
    return Effect.gen(function* () {
      const { refreshToken } = yield* signIn("expiry-race@example.com", "expiryrace");
      const id = hashSessionToken(refreshToken);
      const expiresAt = expiryOf(id)!;

      // One verify reads the session at its expiry second and is held at its delete.
      const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt * 1000);
      const remove = queries.hold(/^delete from "sessions"/);
      const late = yield* Effect.forkChild(Effect.result(auth.verifyRefreshToken(refreshToken)));
      yield* Effect.promise(() => remove.reached);

      // Another, a second earlier, finds it live and extends it.
      clock.mockReturnValue((expiresAt - 1) * 1000);
      yield* auth.verifyRefreshToken(refreshToken);
      remove.release();

      expect((yield* Fiber.join(late))._tag).toBe("Failure");
      expect(expiryOf(id)).toBeGreaterThan(expiresAt);
    }).pipe(Effect.provide(layer));
  });
});
