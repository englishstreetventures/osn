import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type {
  D1Database as DrizzleD1,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { deletionJobs, rotatedSessions, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { handler } from "../../src/index";
import { requestErasure, runHardDeleteSweep } from "../../src/services/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { ROTATION_GRACE_MS } from "../../src/services/auth/constants";
import { hashSessionToken } from "../../src/services/auth/helpers";
import { makeTestAuthConfig } from "../helpers/auth-config";

/**
 * Rotation records on real D1. bun:sqlite runs `commitBatch` statement by
 * statement; D1 runs it as one batch, which is a transaction, and enforces
 * foreign keys. What depends on either is proven here: a rotation's inserts
 * and its delete commit together or not at all, the sweep's `rowid` subquery runs on
 * D1, and erasure removes the records before the account row they reference.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare;
let d1: DrizzleD1;
let db: ReturnType<typeof createD1Db>;
let layer: Layer.Layer<Db>;
let auth: ReturnType<typeof createAuthService>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

/** Effect's failure value, or a thrown error if the effect succeeded. */
const failure = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<E> => run(Effect.flip(eff));

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  db = createD1Db(d1);
  layer = Layer.succeed(Db, { db });
  auth = createAuthService(await makeTestAuthConfig());
});

afterAll(async () => {
  await mf?.dispose();
});

/** Registers an account on D1 and opens one session; returns its refresh token. */
async function signIn(email: string, handle: string) {
  return run(
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
    }),
  );
}

const sessionsOf = (accountId: string) =>
  db.select().from(sessions).where(eq(sessions.accountId, accountId));
const recordsOf = (accountId: string) =>
  db.select().from(rotatedSessions).where(eq(rotatedSessions.accountId, accountId));

describe("rotation records on D1", () => {
  it("a rotation writes the new session and the record of the old token together", async () => {
    const { profile, refreshToken } = await signIn("d1-rot@example.com", "d1rot");

    const next = await run(auth.refreshTokens(refreshToken));

    expect((await sessionsOf(profile.accountId)).map((s) => s.id)).toEqual([
      hashSessionToken(next.refreshToken),
    ]);
    expect((await recordsOf(profile.accountId)).map((r) => r.tokenHash)).toEqual([
      hashSessionToken(refreshToken),
    ]);
  });

  it("when the record cannot be written, the new session is not written either", async () => {
    const { profile, refreshToken } = await signIn("d1-atomic@example.com", "d1atomic");
    // A record already holding this token's hash fails the second insert.
    await db.insert(rotatedSessions).values({
      tokenHash: hashSessionToken(refreshToken),
      familyId: "sfam_other",
      accountId: profile.accountId,
      rotatedAt: 0,
      expiresAt: Date.now() + 60_000,
    });

    const error = await failure(auth.refreshTokens(refreshToken));

    expect(error._tag).toBe("DatabaseError");
    // The whole rotation is one batch: the new session rolled back with the
    // record, and the old session, whose delete was in the same batch, stays
    // and still verifies.
    expect((await sessionsOf(profile.accountId)).map((s) => s.id)).toEqual([
      hashSessionToken(refreshToken),
    ]);
    await run(auth.verifyRefreshToken(refreshToken));
  });

  it("a replay outside the grace window revokes the family and its records", async () => {
    const { profile, refreshToken: t0 } = await signIn("d1-reuse@example.com", "d1reuse");
    const t1 = (await run(auth.refreshTokens(t0))).refreshToken;
    await db
      .update(rotatedSessions)
      .set({ rotatedAt: Date.now() - ROTATION_GRACE_MS - 1 })
      .where(eq(rotatedSessions.accountId, profile.accountId));

    const error = await failure(auth.refreshTokens(t0));

    expect(error._tag).toBe("AuthError");
    expect((await failure(auth.verifyRefreshToken(t1)))._tag).toBe("AuthError");
    expect(await sessionsOf(profile.accountId)).toEqual([]);
    expect(await recordsOf(profile.accountId)).toEqual([]);
  });
});

describe("the 6-hourly cron on D1", () => {
  it("deletes expired rotation records and keeps live ones", async () => {
    const { profile } = await signIn("d1-sweep@example.com", "d1sweep");
    const now = Date.now();
    await db.insert(rotatedSessions).values([
      {
        tokenHash: "d1_dead_1",
        familyId: "f",
        accountId: profile.accountId,
        rotatedAt: 0,
        expiresAt: now - 1,
      },
      {
        tokenHash: "d1_dead_2",
        familyId: "f",
        accountId: profile.accountId,
        rotatedAt: 0,
        expiresAt: now - 1,
      },
      {
        tokenHash: "d1_live_1",
        familyId: "f",
        accountId: profile.accountId,
        rotatedAt: 0,
        expiresAt: now + 3_600_000,
      },
    ]);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const event = { scheduledTime: now, cron: "0 */6 * * *", noRetry: () => {} };

    await handler.scheduled(
      event as unknown as ScheduledController,
      { DB: d1, OSN_ENV: "local" },
      ctx,
    );
    await Promise.all(pending);

    expect((await recordsOf(profile.accountId)).map((r) => r.tokenHash)).toEqual(["d1_live_1"]);
  });

  it("deletes no more chunks a run than OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS allows", async () => {
    const { profile } = await signIn("d1-sweep-cap@example.com", "d1sweepcap");
    const now = Date.now();
    await d1
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 510)
         INSERT INTO rotated_sessions (token_hash, family_id, account_id, rotated_at, expires_at)
         SELECT 'd1_cap_' || i, 'f', ?1, 0, ?2 FROM n`,
      )
      .bind(profile.accountId, now - 1)
      .run();
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const event = { scheduledTime: now, cron: "0 */6 * * *", noRetry: () => {} };

    // One chunk of 500 a run: the default of 10 would have taken all 510.
    await handler.scheduled(
      event as unknown as ScheduledController,
      { DB: d1, OSN_ENV: "local", OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS: "1" },
      ctx,
    );
    await Promise.all(pending);

    expect(await recordsOf(profile.accountId)).toHaveLength(10);
  });
});

/**
 * Logout and a revoke's "was it the caller's own device" answer on D1, where a
 * refresh is one batch: it lands whole between the cookie read and the write,
 * never part way. The revoke reads the caller's family in the same batch as
 * its delete, which only this driver runs.
 */
describe("the caller's device on D1", () => {
  /** A second device on the same account. */
  async function openAnother(profile: Awaited<ReturnType<typeof signIn>>["profile"]) {
    const tokens = await run(
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    return tokens.refreshToken;
  }

  const handleOf = (refreshToken: string) => hashSessionToken(refreshToken).slice(0, 16);

  it("logout with a cookie the device has refreshed past ends the device", async () => {
    const { profile, refreshToken } = await signIn("d1-lo@example.com", "d1lo");
    const other = await openAnother(profile);
    const next = await run(auth.refreshTokens(refreshToken));

    await run(auth.invalidateSession(refreshToken));

    expect((await failure(auth.verifyRefreshToken(next.refreshToken)))._tag).toBe("AuthError");
    await run(auth.verifyRefreshToken(other));
  });

  it("revoking the caller's own live session reports it as the caller's", async () => {
    const { profile, refreshToken } = await signIn("d1-rs0@example.com", "d1rs0");

    const result = await run(
      auth.revokeAccountSession(
        profile.accountId,
        handleOf(refreshToken),
        hashSessionToken(refreshToken),
      ),
    );

    expect(result.revokedSelf).toBe(true);
    expect(await sessionsOf(profile.accountId)).toEqual([]);
  });

  it("revoking the device a refreshed-past cookie names reports it as the caller's", async () => {
    const { profile, refreshToken } = await signIn("d1-rs@example.com", "d1rs");
    const next = await run(auth.refreshTokens(refreshToken));

    const result = await run(
      auth.revokeAccountSession(
        profile.accountId,
        handleOf(refreshToken),
        hashSessionToken(refreshToken),
      ),
    );

    expect(result.revokedSelf).toBe(true);
    expect((await failure(auth.verifyRefreshToken(next.refreshToken)))._tag).toBe("AuthError");
  });

  it("revoking another device is not the caller's", async () => {
    const { profile, refreshToken } = await signIn("d1-rs4@example.com", "d1rs4");
    const other = await openAnother(profile);
    const next = await run(auth.refreshTokens(refreshToken));

    const result = await run(
      auth.revokeAccountSession(profile.accountId, handleOf(other), hashSessionToken(refreshToken)),
    );

    expect(result.revokedSelf).toBe(false);
    await run(auth.verifyRefreshToken(next.refreshToken));
  });
});

describe("account erasure on D1", () => {
  it("soft delete keeps only the cancel handle's family's records", async () => {
    const { profile, refreshToken } = await signIn("d1-soft@example.com", "d1soft");
    const kept = await run(auth.refreshTokens(refreshToken));
    await db.insert(rotatedSessions).values({
      tokenHash: "d1_soft_other",
      familyId: "sfam_revoked",
      accountId: profile.accountId,
      rotatedAt: 0,
      expiresAt: Date.now() + 3_600_000,
    });

    await run(
      requestErasure({
        accountId: profile.accountId,
        cancelSessionId: hashSessionToken(kept.refreshToken),
      }),
    );

    expect((await recordsOf(profile.accountId)).map((r) => r.tokenHash)).toEqual([
      hashSessionToken(refreshToken),
    ]);
  });

  it("hard delete removes the records before the account row they reference", async () => {
    const { profile, refreshToken } = await signIn("d1-hard@example.com", "d1hard");
    await run(auth.refreshTokens(refreshToken));
    expect(await recordsOf(profile.accountId)).toHaveLength(1);
    await db.insert(deletionJobs).values({
      accountId: profile.accountId,
      softDeletedAt: 1_000,
      hardDeleteAt: 2_000,
      pulseDoneAt: 1_500,
      zapDoneAt: 1_500,
      reason: "user_request",
      cancelSessionId: null,
    });

    const result = await run(runHardDeleteSweep({ nowMs: 5_000_000 }));

    expect(result.purged).toBe(1);
    expect(await recordsOf(profile.accountId)).toEqual([]);
  });
});
