import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import {
  accounts,
  appEnrollments,
  connections,
  deletionJobs,
  organisationMembers,
  organisations,
  passkeys,
  recoveryCodes,
  securityEvents,
  serviceAccountKeys,
  serviceAccounts,
  sessions,
  totpCredentials,
  users,
} from "@osn/db/schema";
import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import {
  clearPublicKeyCache,
  createArcToken,
  exportKeyToJwk,
  generateArcKeyPair,
} from "@shared/crypto";
import { commitBatch, createD1Db, rowsChanged } from "@shared/db-utils";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { UNIQUE_CONSTRAINT_ERROR } from "../../src/lib/unique-constraint";
import { createInternalGraphRoutes } from "../../src/routes/graph-internal";
import {
  cancelErasure,
  getDeletionStatus,
  requestErasure,
} from "../../src/services/account-erasure";
import { createRecommendationService } from "../../src/services/recommendations";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// The rest of the OSN suite runs on synchronous bun:sqlite; these exercise the
// ASYNCHRONOUS D1 driver path — specifically the multi-statement
// `commitBatch` → `db.batch([...])` branch of the account-erasure flows, which
// the bun:sqlite unit suite never reaches. This is the only coverage of the D1
// transaction-equivalent (batch) path for OSN core.

/* eslint-disable no-await-in-loop */

const ACCOUNT_ID = "acc_d1test";

// Every hook and test in this file runs on this budget instead of bun's
// 5 000 ms default; `setDefaultTimeout` sets it for this file only. When a
// Miniflare-backed test outlives its budget, bun kills the file's workerd and
// every later test fails on the dead runtime, so one late test on a slow
// runner turns the whole file red. On a 4-core machine the slowest test takes
// about 0.5 s idle, 1 s with every core busy and under 3 s with four busy
// processes per core; the budget sits far above all three. The bulk seeds go
// through `seedInWorkerd`, so no test's time grows with the number of rows it
// seeds.
const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare;
let d1: DrizzleD1;
let layer: Layer.Layer<Db>;
let rawDb: ReturnType<typeof createD1Db<typeof schema>>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

/**
 * The file's Worker. A POST carries `[{ sql, params }]`, and the Worker runs
 * it as one D1 batch against its own binding: in order, all or nothing.
 */
const D1_WORKER = `
export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok");
    try {
      const statements = await request.json();
      await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
      return Response.json({ ran: statements.length });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
`;

/**
 * Writes `queries` inside workerd, as one D1 batch, in one request.
 *
 * `mf.getD1Database()` hands back a proxy, and each `prepare` and `bind` on it
 * is a synchronous round trip to workerd (Miniflare waits on it with
 * `Atomics.wait` on this thread). A seed of hundreds of rows through it makes
 * thousands of them, and each one slows down when the machine is busy. This
 * sends the SQL and the driver-mapped parameters drizzle built for every
 * statement in one `dispatchFetch` instead, and the Worker prepares and binds
 * them itself. Each statement inserts one row, so it stays far under D1's 100
 * bound parameters per statement.
 */
const seedInWorkerd = async (
  queries: ReadonlyArray<{ toSQL(): { sql: string; params: unknown[] } }>,
): Promise<void> => {
  if (queries.length === 0) return;
  const res = await mf.dispatchFetch("http://d1.test/", {
    method: "POST",
    body: JSON.stringify(queries.map((q) => q.toSQL())),
  });
  if (!res.ok) throw new Error(`seed batch failed: ${await res.text()}`);
};

/**
 * Wraps a D1 binding so every `SELECT` whose SQL text contains `tableHint`
 * has its `meta.rows_read` (D1's own read-accounting figure — see
 * developers.cloudflare.com/d1/platform/limits/) added to a running total,
 * readable once every in-flight measurement has resolved.
 *
 * This is the only way this repo can *observe* whether a fan-out's read is
 * actually bounded rather than merely assumed to be: bun:sqlite (every other
 * test in the suite) reports no such figure, and D1 is the driver production
 * runs on.
 *
 * It cannot read `.meta` off the call drizzle itself makes: for a `select({
 * ... })` with an explicit field list, drizzle's D1 driver calls
 * `.raw()`, not `.all()`/`.run()` — `.raw()` returns bare row tuples with no
 * `.meta` at all (`D1PreparedStatement.raw()` in `@cloudflare/workers-types`).
 * So on every matching `bind()`, this fires a second, identically-bound
 * `.all()` purely to read its `meta.rows_read` — safe because every query
 * this test runs through it is a pure `SELECT` — and leaves the statement
 * drizzle actually executes untouched, `.raw()` and all, so the real result
 * path behaves exactly as production does.
 */
function trackRowsRead(
  base: DrizzleD1,
  tableHint: string,
): { d1: DrizzleD1; total: () => Promise<number> } {
  let total = 0;
  const pending: Promise<void>[] = [];
  const tracked = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (query: string) => {
        const stmt = target.prepare(query);
        if (!query.includes(tableHint)) return stmt;
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp, stmtReceiver) {
            if (stmtProp !== "bind") return Reflect.get(stmtTarget, stmtProp, stmtReceiver);
            return (...values: unknown[]) => {
              pending.push(
                target
                  .prepare(query)
                  .bind(...values)
                  .all()
                  .then((res) => {
                    total += res.meta.rows_read ?? 0;
                    return undefined;
                  }),
              );
              return stmtTarget.bind(...values);
            };
          },
        });
      };
    },
  });
  return {
    d1: tracked,
    total: async () => {
      await Promise.all(pending);
      return total;
    },
  };
}

/**
 * Wraps a D1 binding so the first statement whose SQL text contains
 * `sqlHint` does not actually run against the database until `beforeQuery`
 * has resolved.
 *
 * This is the test seam for the race between `suggestConnections`'s step 1
 * (`myEdgeRows`, a snapshot) and step 2 (the FOF fan-out, whose seed subquery
 * reads `connections` live): a real write has to land in the gap between
 * them, a gap with a genuine D1 round trip in it, which a single in-process
 * call cannot reproduce by itself.
 * Racing two real overlapping HTTP requests against the same Miniflare
 * instance would depend on scheduler timing and be flaky by construction;
 * this instead hooks the exact D1 call boundary the race depends on and
 * forces the write to land inside it, deterministically, every run.
 *
 * `.bind()` returns synchronously (`D1PreparedStatement`'s real shape), so
 * the injection can't happen there — it has to happen on the method that
 * actually issues the query. Drizzle's D1 driver calls `.raw()` for an
 * explicit-field-list `select` (see `trackRowsRead`'s doc above), but this
 * wraps `.raw()`, `.all()` and `.run()` alike so it works regardless of
 * which one a given query shape uses.
 */
function raceInsertBeforeQuery(
  base: DrizzleD1,
  sqlHint: string,
  beforeQuery: () => Promise<void>,
): DrizzleD1 {
  let armed = true;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (query: string) => {
        const stmt = target.prepare(query);
        if (!armed || !query.includes(sqlHint)) return stmt;
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp, stmtReceiver) {
            if (stmtProp !== "bind") return Reflect.get(stmtTarget, stmtProp, stmtReceiver);
            return (...values: unknown[]) => {
              const bound = stmtTarget.bind(...values);
              return new Proxy(bound, {
                get(boundTarget, boundProp, boundReceiver) {
                  if (boundProp !== "raw" && boundProp !== "all" && boundProp !== "run") {
                    return Reflect.get(boundTarget, boundProp, boundReceiver);
                  }
                  const orig = (
                    Reflect.get(boundTarget, boundProp, boundReceiver) as (
                      ...args: unknown[]
                    ) => unknown
                  ).bind(boundTarget);
                  return async (...args: unknown[]) => {
                    armed = false; // once only — the seed subquery re-runs inside the same statement, not as a separate prepare
                    await beforeQuery();
                    return orig(...args);
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

const seedAccount = async (): Promise<void> => {
  const ts = new Date();
  await rawDb.insert(accounts).values({
    id: ACCOUNT_ID,
    email: "d1@example.com",
    passkeyUserId: crypto.randomUUID(),
    createdAt: ts,
    updatedAt: ts,
  });
};

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: D1_WORKER,
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  rawDb = createD1Db(d1, schema);
  layer = Layer.succeed(Db, { db: rawDb });
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  // FK-safe truncation (D1 enforces foreign keys): every table that erasure
  // OR the recommendations tests below write, and that references `accounts`
  // or `users`, must be cleared before those parent rows.
  for (const table of [
    deletionJobs,
    securityEvents,
    sessions,
    passkeys,
    recoveryCodes,
    totpCredentials,
    appEnrollments,
    connections,
    organisationMembers,
    organisations,
    users,
    accounts,
  ]) {
    await rawDb.delete(table);
  }
  await seedAccount();
});

describe("osn/api account erasure over real D1 (Miniflare)", () => {
  it("requestErasure commits the multi-statement batch atomically on D1", async () => {
    const out = await run(requestErasure({ accountId: ACCOUNT_ID, cancelSessionId: "ses_keep" }));
    expect(out.newlyScheduled).toBe(true);

    // The batch tombstoned the account and wrote a deletion job.
    const acct = await rawDb.select().from(accounts).where(eq(accounts.id, ACCOUNT_ID));
    expect(acct[0]!.deletedAt).not.toBeNull();

    const status = await run(getDeletionStatus(ACCOUNT_ID));
    expect(status.scheduled).toBe(true);
  });

  it("cancelErasure clears the job + un-tombstones via the async batch path", async () => {
    await run(requestErasure({ accountId: ACCOUNT_ID, cancelSessionId: "ses_keep" }));
    const cancelled = await run(cancelErasure(ACCOUNT_ID));
    expect(cancelled.cancelled).toBe(true);

    const acct = await rawDb.select().from(accounts).where(eq(accounts.id, ACCOUNT_ID));
    expect(acct[0]!.deletedAt).toBeNull();
    expect((await run(getDeletionStatus(ACCOUNT_ID))).scheduled).toBe(false);
  });
});

describe("TOTP blob columns over real D1 (Miniflare)", () => {
  // The ONLY blob columns in this schema, and the unit suite runs on
  // bun:sqlite. drizzle normalises the READ side for both drivers
  // (`SQLiteBlobBuffer.mapFromDriverValue` wraps whatever comes back in
  // `Buffer.from`), so the untested half is the WRITE: what D1's `bind()` does
  // with a Node Buffer. Hence insert-then-select-then-compare rather than
  // reading a seeded row — a seeded row would prove nothing about the path
  // production actually takes.
  it("round-trips a ciphertext and IV through a real D1 write and read", async () => {
    const ciphertext = new Uint8Array(36);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(ciphertext);
    crypto.getRandomValues(iv);

    const nowSec = Math.floor(Date.now() / 1000);
    await rawDb.insert(totpCredentials).values({
      id: "totp_d1round1",
      accountId: ACCOUNT_ID,
      secretCiphertext: Buffer.from(ciphertext),
      iv: Buffer.from(iv),
      keyVersion: 1,
      label: "D1 round trip",
      confirmedAt: nowSec,
      lastUsedAt: nowSec,
      lastUsedStep: 12345,
      createdAt: nowSec,
    });

    const rows = await rawDb
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.id, "totp_d1round1"));
    const row = rows[0]!;

    // Byte-for-byte, not just "truthy": a driver that stringified the buffer
    // would still return something non-empty here.
    expect(Buffer.from(row.secretCiphertext).equals(Buffer.from(ciphertext))).toBe(true);
    expect(Buffer.from(row.iv).equals(Buffer.from(iv))).toBe(true);
    expect(row.keyVersion).toBe(1);
    expect(row.lastUsedStep).toBe(12345);
  });

  it("round-trips a re-encrypted ciphertext through a real D1 conditional UPDATE", async () => {
    // The key rotation re-encrypts a credential inside the same conditional
    // UPDATE that consumes the TOTP step, so the blob columns are now written
    // by an UPDATE and not only by an INSERT. That is a second write path
    // through `bind()`, and the insert test above says nothing about it: a
    // driver could take a Buffer in an INSERT and mangle it in an UPDATE's SET
    // list, and the bun:sqlite unit suite would never see the difference.
    const nowSec = Math.floor(Date.now() / 1000);
    await rawDb.insert(totpCredentials).values({
      id: "totp_d1rekey",
      accountId: ACCOUNT_ID,
      secretCiphertext: Buffer.from(new Uint8Array(36).fill(1)),
      iv: Buffer.from(new Uint8Array(12).fill(2)),
      keyVersion: 1,
      confirmedAt: nowSec,
      lastUsedAt: nowSec,
      lastUsedStep: 100,
      createdAt: nowSec,
    });

    const rekeyed = new Uint8Array(36);
    const rekeyedIv = new Uint8Array(12);
    crypto.getRandomValues(rekeyed);
    crypto.getRandomValues(rekeyedIv);

    // The real statement's shape, guard included: the step, the timestamp and
    // all three rotation columns move together or not at all.
    await rawDb
      .update(totpCredentials)
      .set({
        lastUsedStep: 101,
        lastUsedAt: nowSec + 30,
        secretCiphertext: Buffer.from(rekeyed),
        iv: Buffer.from(rekeyedIv),
        keyVersion: 2,
      })
      .where(
        and(
          eq(totpCredentials.id, "totp_d1rekey"),
          isNotNull(totpCredentials.confirmedAt),
          sql`(${totpCredentials.lastUsedStep} is null or ${totpCredentials.lastUsedStep} < 101)`,
        ),
      );

    const rows = await rawDb
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.id, "totp_d1rekey"));
    const row = rows[0]!;

    // Byte-for-byte: a ciphertext that came back as a stringified buffer would
    // decrypt to nothing, and the owner would lose their second factor while
    // the row looked perfectly healthy.
    expect(Buffer.from(row.secretCiphertext).equals(Buffer.from(rekeyed))).toBe(true);
    expect(Buffer.from(row.iv).equals(Buffer.from(rekeyedIv))).toBe(true);
    expect(row.keyVersion).toBe(2);
    expect(row.lastUsedStep).toBe(101);
  });

  it("writes no ciphertext when the single-use guard rejects", async () => {
    // One statement carries both the replay guard and the re-encryption. If a
    // losing racer could still write its ciphertext, a row would end up holding
    // one key's bytes under another key's version stamp.
    const nowSec = Math.floor(Date.now() / 1000);
    const original = new Uint8Array(36).fill(7);
    await rawDb.insert(totpCredentials).values({
      id: "totp_d1guard",
      accountId: ACCOUNT_ID,
      secretCiphertext: Buffer.from(original),
      iv: Buffer.from(new Uint8Array(12).fill(8)),
      keyVersion: 1,
      confirmedAt: nowSec,
      lastUsedAt: nowSec,
      lastUsedStep: 500,
      createdAt: nowSec,
    });

    const result = await rawDb
      .update(totpCredentials)
      .set({
        lastUsedStep: 500,
        lastUsedAt: nowSec + 30,
        secretCiphertext: Buffer.from(new Uint8Array(36).fill(9)),
        iv: Buffer.from(new Uint8Array(12).fill(10)),
        keyVersion: 2,
      })
      .where(
        and(
          eq(totpCredentials.id, "totp_d1guard"),
          isNotNull(totpCredentials.confirmedAt),
          // 500 is not < 500: the step is already spent.
          sql`(${totpCredentials.lastUsedStep} is null or ${totpCredentials.lastUsedStep} < 500)`,
        ),
      );

    expect(rowsChanged(result)).toBe(0);

    const rows = await rawDb
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.id, "totp_d1guard"));
    const row = rows[0]!;
    expect(Buffer.from(row.secretCiphertext).equals(Buffer.from(original))).toBe(true);
    expect(row.keyVersion).toBe(1);
  });

  it("enforces one CONFIRMED credential per account through the partial unique index", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const base = {
      accountId: ACCOUNT_ID,
      secretCiphertext: Buffer.from(new Uint8Array(36)),
      iv: Buffer.from(new Uint8Array(12)),
      keyVersion: 1,
      createdAt: nowSec,
    };

    await rawDb
      .insert(totpCredentials)
      .values({ ...base, id: "totp_d1uniq1", confirmedAt: nowSec });

    let threw = false;
    try {
      await rawDb
        .insert(totpCredentials)
        .values({ ...base, id: "totp_d1uniq2", confirmedAt: nowSec });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Unconfirmed rows are NOT covered by the index — an abandoned enrolment
    // must never block a retry.
    await rawDb.insert(totpCredentials).values({ ...base, id: "totp_d1uniq3", confirmedAt: null });
    const all = await rawDb
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.accountId, ACCOUNT_ID));
    expect(all).toHaveLength(2);
  });

  it("cascades the credential away when the account row goes", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await rawDb.insert(totpCredentials).values({
      id: "totp_d1cascade",
      accountId: ACCOUNT_ID,
      secretCiphertext: Buffer.from(new Uint8Array(36)),
      iv: Buffer.from(new Uint8Array(12)),
      keyVersion: 1,
      confirmedAt: nowSec,
      createdAt: nowSec,
    });

    // D1 enforces foreign keys, so this exercises the real ON DELETE CASCADE.
    await rawDb.delete(sessions).where(eq(sessions.accountId, ACCOUNT_ID));
    await rawDb.delete(users).where(eq(users.accountId, ACCOUNT_ID));
    await rawDb.delete(accounts).where(eq(accounts.id, ACCOUNT_ID));

    expect(await rawDb.select().from(totpCredentials)).toHaveLength(0);
  });
});

describe("UNIQUE_CONSTRAINT_ERROR over real D1 (Miniflare)", () => {
  it("matches a duplicate-email conflict raised through commitBatch", async () => {
    const ts = new Date();
    let threw = false;
    try {
      await commitBatch(rawDb, [
        rawDb.insert(accounts).values({
          id: "acc_d1test_dup",
          email: "d1@example.com", // already seeded on ACCOUNT_ID
          passkeyUserId: crypto.randomUUID(),
          createdAt: ts,
          updatedAt: ts,
        }),
      ]);
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      expect(UNIQUE_CONSTRAINT_ERROR.test(msg)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it("does not match a foreign-key violation raised through commitBatch", async () => {
    const ts = new Date();
    let threw = false;
    try {
      await commitBatch(rawDb, [
        rawDb.insert(users).values({
          id: "usr_d1test_orphan",
          accountId: "acc_does_not_exist",
          handle: "orphan",
          createdAt: ts,
          updatedAt: ts,
        }),
      ]);
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      expect(UNIQUE_CONSTRAINT_ERROR.test(msg)).toBe(false);
    }
    expect(threw).toBe(true);
  });
});

// The two describes below are the first D1 coverage of
// `services/recommendations.ts` — everything else exercising it runs on
// synchronous bun:sqlite, which cannot see either the read-accounting D1
// reports or the bound-parameter cap D1 enforces.
describe("osn/api recommendations co-member fan-out over real D1 (Miniflare)", () => {
  it("stays within the MAX_ORG_COMEMBER_ROWS budget even when one organisation has far more members than its share", async () => {
    // Each organisation the caller belongs to gets its own even share of the
    // row budget, rather than one global cap the caller's first (lowest-id)
    // organisation could fill entirely while every other organisation got
    // nothing. MAX_ORG_COMEMBER_ROWS (services/recommendations.ts) is 2 000,
    // split evenly across the caller's organisations, so a caller in one
    // organisation gives it the whole budget and proving the cap would take
    // more than 2 000 members.
    //
    // Putting the caller in ORG_COUNT organisations shrinks each one's share
    // to `MAX_ORG_COMEMBER_ROWS / ORG_COUNT`: with 10 organisations the share
    // is 200, and 500 members in the one oversized organisation is 2.5 times
    // its share, a clear excess for the fan-out to cap. The other nine
    // organisations need no extra members; the caller's own membership row
    // is enough to exercise their arm of the fan-out.
    const callerId = "usr_boundtest_caller";
    const callerAccountId = "acc_boundtest_caller";
    const ts = new Date();
    const ORG_COUNT = 10;
    const OVERSIZED_ORG_ID = "org_boundtest_0";
    const MEMBER_COUNT = 500;
    const memberIndices = Array.from({ length: MEMBER_COUNT }, (_, n) => n);

    // 1 522 rows in FK order, in one request.
    await seedInWorkerd([
      rawDb.insert(accounts).values({
        id: callerAccountId,
        email: "boundtest-caller@example.com",
        passkeyUserId: crypto.randomUUID(),
        createdAt: ts,
        updatedAt: ts,
      }),
      rawDb.insert(users).values({
        id: callerId,
        accountId: callerAccountId,
        handle: "boundtest_caller",
        createdAt: ts,
        updatedAt: ts,
      }),
      ...Array.from({ length: ORG_COUNT }, (_, i) => [
        rawDb.insert(organisations).values({
          id: `org_boundtest_${i}`,
          handle: `boundtest${i}`,
          name: `Bound Test Org ${i}`,
          ownerId: callerId,
          createdAt: ts,
          updatedAt: ts,
        }),
        rawDb.insert(organisationMembers).values({
          id: `orgm_boundtest_caller_${i}`,
          organisationId: `org_boundtest_${i}`,
          profileId: callerId,
          role: "admin",
          createdAt: ts,
        }),
      ]).flat(),
      ...memberIndices.map((n) =>
        rawDb.insert(accounts).values({
          id: `acc_boundtest_m${n}`,
          email: `boundtest-m${n}@example.com`,
          passkeyUserId: crypto.randomUUID(),
          createdAt: ts,
          updatedAt: ts,
        }),
      ),
      ...memberIndices.map((n) =>
        rawDb.insert(users).values({
          id: `usr_boundtest_m${n}`,
          accountId: `acc_boundtest_m${n}`,
          handle: `boundtestm${n}`,
          createdAt: ts,
          updatedAt: ts,
        }),
      ),
      ...memberIndices.map((n) =>
        rawDb.insert(organisationMembers).values({
          id: `orgm_boundtest_m${n}`,
          organisationId: OVERSIZED_ORG_ID,
          profileId: `usr_boundtest_m${n}`,
          role: "member" as const,
          createdAt: ts,
        }),
      ),
    ]);

    // The bound below means something only while the oversized organisation
    // really holds more than its share: its 500 members and the caller.
    const [seeded] = await rawDb
      .select({ members: count() })
      .from(organisationMembers)
      .where(eq(organisationMembers.organisationId, OVERSIZED_ORG_ID));
    expect(seeded!.members).toBe(MEMBER_COUNT + 1);

    const { d1: trackedD1, total } = trackRowsRead(d1, "organisation_members");
    const trackedLayer = Layer.succeed(Db, { db: createD1Db(trackedD1, schema) });
    const recs = createRecommendationService();

    const suggestions = await Effect.runPromise(
      recs.suggestConnections(callerId, 50).pipe(Effect.provide(trackedLayer)),
    );

    const rowsRead = await total();
    expect(suggestions.length).toBeGreaterThan(0);
    // 500 members exist in the oversized organisation alone, against a
    // 200-row share; the read must never approach 500. The other nine
    // organisations contribute at most one row each (the caller's own
    // membership), and the caller's own organisation list is a separate,
    // tiny query against the same table — so 300 comfortably covers the
    // 200-row share plus that overhead, while still sitting far under both
    // the oversized organisation's real membership count and the 2 000
    // global budget.
    expect(rowsRead).toBeLessThanOrEqual(300);
  });

  it("does not throw for a caller in 6 organisations, one more than D1's compound SELECT allows", async () => {
    // The co-member fan-out has one `UNION ALL` arm per organisation the
    // caller belongs to. `bun:sqlite` allows 500 terms in a compound SELECT;
    // D1 runs on workerd's embedded SQLite, which allows 5
    // (`MAX_ORG_COMEMBER_ARMS_PER_QUERY`, see its comment in
    // services/recommendations.ts), and a single statement for a caller in 6
    // or more organisations fails with `D1_ERROR: too many terms in compound
    // SELECT`. This seeds exactly that caller, 6 organisations with one arm
    // each, and asserts `suggestConnections` succeeds: the batching in
    // services/recommendations.ts is what keeps it green.
    const callerId = "usr_sixorg_caller";
    const callerAccountId = "acc_sixorg_caller";
    const ts = new Date();
    await rawDb.insert(accounts).values({
      id: callerAccountId,
      email: "sixorg-caller@example.com",
      passkeyUserId: crypto.randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(users).values({
      id: callerId,
      accountId: callerAccountId,
      handle: "sixorg_caller",
      createdAt: ts,
      updatedAt: ts,
    });

    const ORG_COUNT = 6;
    for (let i = 0; i < ORG_COUNT; i++) {
      const organisationId = `org_sixorg_${i}`;
      const memberAccountId = `acc_sixorg_m${i}`;
      const memberId = `usr_sixorg_m${i}`;
      // eslint-disable-next-line no-await-in-loop -- sequential, FK-ordered seeding
      await rawDb.insert(organisations).values({
        id: organisationId,
        handle: `sixorg${i}`,
        name: `Six Org ${i}`,
        ownerId: callerId,
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(organisationMembers).values({
        id: `orgm_sixorg_caller_${i}`,
        organisationId,
        profileId: callerId,
        role: "admin",
        createdAt: ts,
      });
      // A co-member per organisation, so the fan-out has a real candidate to
      // surface — not merely a query that returns nothing without throwing.
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(accounts).values({
        id: memberAccountId,
        email: `sixorg-m${i}@example.com`,
        passkeyUserId: crypto.randomUUID(),
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(users).values({
        id: memberId,
        accountId: memberAccountId,
        handle: `sixorgm${i}`,
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(organisationMembers).values({
        id: `orgm_sixorg_m${i}`,
        organisationId,
        profileId: memberId,
        role: "member" as const,
        createdAt: ts,
      });
    }

    const recs = createRecommendationService();
    const suggestions = await run(recs.suggestConnections(callerId, 50));

    expect(suggestions.length).toBe(ORG_COUNT);
  });
});

describe("osn/api recommendations FOF fan-out over real D1 (Miniflare)", () => {
  it("suggestConnections answers for a caller with 60 accepted connections, past D1's 100-bound-parameter cap at two binds per id", async () => {
    // D1 caps a statement at 100 bound parameters, inside a batch as well
    // (developers.cloudflare.com/d1/platform/limits/: "Maximum bound
    // parameters per query | 100"). A FOF fan-out that bound the caller's
    // connection ids once per edge direction, in
    // `inArray(requesterId, ids) OR inArray(addresseeId, ids)`, would bind 120
    // for this caller and fail with `D1_ERROR: too many SQL variables`. The
    // query in services/recommendations.ts reads the caller's accepted edges
    // through a correlated `IN (<subquery>)` bound by `profileId` alone, so its
    // bind count does not grow with the caller's connections; its comment
    // says why a correlated `EXISTS` was measured and not used. Miniflare
    // enforces the same cap, so this proves the call succeeds over real D1 and
    // returns real friend-of-friend suggestions.
    const callerId = "usr_bindtest_caller";
    const callerAccountId = "acc_bindtest_caller";
    const ts = new Date();
    const FRIEND_COUNT = 60;
    // A handful of the caller's friends each have one connection of their
    // own beyond the caller: real friend-of-friend candidates, so this proves
    // the query returns correct suggestions, not merely that it avoids
    // throwing.
    const FOF_CANDIDATE_COUNT = 3;
    const person = (accountId: string, id: string, handle: string) => [
      rawDb.insert(accounts).values({
        id: accountId,
        email: `${handle}@example.com`,
        passkeyUserId: crypto.randomUUID(),
        createdAt: ts,
        updatedAt: ts,
      }),
      rawDb.insert(users).values({ id, accountId, handle, createdAt: ts, updatedAt: ts }),
    ];
    const accepted = (id: string, requesterId: string, addresseeId: string) =>
      rawDb.insert(connections).values({
        id,
        requesterId,
        addresseeId,
        status: "accepted",
        createdAt: ts,
        updatedAt: ts,
      });

    // 191 rows in FK order, in one request.
    await seedInWorkerd([
      ...person(callerAccountId, callerId, "bindtest_caller"),
      ...Array.from({ length: FRIEND_COUNT }, (_, i) => [
        ...person(`acc_bindtest_f${i}`, `usr_bindtest_f${i}`, `bindtestf${i}`),
        accepted(`conn_bindtest_${i}`, callerId, `usr_bindtest_f${i}`),
      ]).flat(),
      ...Array.from({ length: FOF_CANDIDATE_COUNT }, (_, i) => [
        ...person(`acc_bindtest_fof${i}`, `usr_bindtest_fof${i}`, `bindtestfof${i}`),
        // `usr_bindtest_f${i}` is one of the caller's direct friends.
        accepted(`conn_bindtest_fof_${i}`, `usr_bindtest_f${i}`, `usr_bindtest_fof${i}`),
      ]).flat(),
    ]);

    const recs = createRecommendationService();
    const suggestions = await run(recs.suggestConnections(callerId, 50));

    const suggestedHandles = suggestions.map((s) => s.handle);
    for (let i = 0; i < FOF_CANDIDATE_COUNT; i++) {
      expect(suggestedHandles).toContain(`bindtestfof${i}`);
    }
    // None of the caller's own 60 direct friends should ever come back as a
    // suggestion — they are already connections, not candidates.
    for (const s of suggestions) {
      expect(s.handle.startsWith("bindtestf") && !s.handle.startsWith("bindtestfof")).toBe(false);
    }
  });

  it("does not suggest a connection the caller accepted, in a second in-flight request, between step 1 and the FOF fan-out", async () => {
    // `suggestConnections` reads the caller's own context in two separate,
    // un-transacted D1 round trips: step 1 (`myEdgeRows`, a snapshot) and
    // step 2 (the FOF fan-out, whose seed subquery reads `connections` live,
    // as the test above relies on). If the caller accepts a new connection in
    // the gap between them — the same account, a second request in flight
    // from another tab or device — step 1's snapshot never saw it, so it is
    // in neither `myConnectionIdSet` nor `excludeIds`, but the live seed
    // subquery sees it. The service must still not classify the fan-out row
    // for that brand-new edge as a candidate: otherwise the caller's own
    // newest connection comes back as "someone you may know."
    //
    // Reproducing the race with two real overlapping HTTP requests would
    // depend on scheduler timing and be flaky by construction. Instead this
    // uses `raceInsertBeforeQuery` (above) as a test seam: it hooks the
    // exact D1 statement the race depends on — the FOF fan-out SELECT,
    // identified by its compiled SQL text, confirmed against this Miniflare
    // version rather than guessed — and forces the caller's new connection
    // to commit immediately before that statement actually runs. That lands
    // the write inside the real gap `suggestConnections` leaves open,
    // deterministically, without touching the service under test.
    const callerId = "usr_racetest_caller";
    const callerAccountId = "acc_racetest_caller";
    const ts = new Date();
    await rawDb.insert(accounts).values({
      id: callerAccountId,
      email: "racetest-caller@example.com",
      passkeyUserId: crypto.randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(users).values({
      id: callerId,
      accountId: callerAccountId,
      handle: "racetest_caller",
      createdAt: ts,
      updatedAt: ts,
    });

    // An existing accepted friend, seeded before the race — this is what
    // keeps `myConnectionIds` non-empty at step 1, so the FOF fan-out branch
    // actually runs rather than being skipped for an empty seed set.
    const friendId = "usr_racetest_friend";
    await rawDb.insert(accounts).values({
      id: "acc_racetest_friend",
      email: "racetest-friend@example.com",
      passkeyUserId: crypto.randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(users).values({
      id: friendId,
      accountId: "acc_racetest_friend",
      handle: "racetest_friend",
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(connections).values({
      id: "conn_racetest_friend",
      requesterId: friendId,
      addresseeId: callerId,
      status: "accepted",
      createdAt: ts,
      updatedAt: ts,
    });

    // The user who becomes a connection mid-flight. The user/account rows
    // must already exist — only the `connections` row is inserted during
    // the race, since that edge is the thing the race actually creates.
    const lateId = "usr_racetest_late";
    await rawDb.insert(accounts).values({
      id: "acc_racetest_late",
      email: "racetest-late@example.com",
      passkeyUserId: crypto.randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(users).values({
      id: lateId,
      accountId: "acc_racetest_late",
      handle: "racetest_late",
      createdAt: ts,
      updatedAt: ts,
    });

    const racedD1 = raceInsertBeforeQuery(
      d1,
      // The FOF fan-out SELECT (services/recommendations.ts) — confirmed
      // against this Miniflare version's actual compiled SQL. Distinct from
      // step 1's `myEdgeRows` select, which also selects `"status"` and so
      // does not contain this exact substring.
      '"requester_id", "addressee_id" from "connections"',
      async () => {
        await rawDb.insert(connections).values({
          id: "conn_racetest_late",
          requesterId: lateId,
          addresseeId: callerId,
          status: "accepted",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      },
    );
    const racedLayer = Layer.succeed(Db, { db: createD1Db(racedD1, schema) });

    const recs = createRecommendationService();
    const suggestions = await Effect.runPromise(
      recs.suggestConnections(callerId, 50).pipe(Effect.provide(racedLayer)),
    );

    // The race landed for real — this is not a no-op fixture.
    const lateEdge = await rawDb
      .select()
      .from(connections)
      .where(eq(connections.id, "conn_racetest_late"));
    expect(lateEdge).toHaveLength(1);

    // The caller's own brand-new connection must never come back as
    // "someone you may know".
    const suggestedHandles = suggestions.map((s) => s.handle);
    expect(suggestedHandles).not.toContain("racetest_late");
  });
});

describe("recovery passkey reclaim over real D1 (Miniflare)", () => {
  // `englishstreetventures/osn#970`. The reclaim deletes a credential and inserts its
  // replacement in ONE `commitBatch`, and that is the only thing standing
  // between a recovering user and an account left a credential down.
  //
  // No test on the ordinary tier can see it. `commitBatch` falls back to running
  // statements sequentially on `bun:sqlite` (there is no batch), so the whole
  // vitest suite would stay green on a delete that committed while its insert
  // failed. Only this tier reaches `db.batch`, so this is where atomicity is
  // asserted rather than assumed.

  const seedPasskey = (
    id: string,
    provenanceAmr: string | null,
    createdAt: Date,
    credentialId = `d1-${id}`,
  ) =>
    rawDb.insert(passkeys).values({
      id,
      accountId: ACCOUNT_ID,
      credentialId,
      publicKey: "AQIDBA==",
      counter: 0,
      transports: null,
      createdAt,
      label: null,
      provenanceAmr,
      lastUsedAt: null,
      aaguid: null,
      backupEligible: false,
      backupState: false,
      updatedAt: Math.floor(Date.now() / 1000),
    });

  it("commits the delete and its replacement insert as one batch", async () => {
    await seedPasskey("pk_d1_keep", "webauthn", new Date());
    await seedPasskey("pk_d1_lent", "recovery", new Date());

    await commitBatch(rawDb, [
      rawDb.delete(passkeys).where(eq(passkeys.id, "pk_d1_lent")),
      seedPasskey("pk_d1_new", "recovery", new Date()),
      rawDb.insert(securityEvents).values({
        id: "sev_d1_reclaim",
        accountId: ACCOUNT_ID,
        kind: "passkey_reclaimed",
        createdAt: Math.floor(Date.now() / 1000),
        acknowledgedAt: null,
        ipHash: null,
        uaLabel: null,
      }),
    ]);

    const rows = await rawDb.select().from(passkeys).where(eq(passkeys.accountId, ACCOUNT_ID));
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("pk_d1_lent");
    expect(ids).toContain("pk_d1_new");
    // The count is unchanged: one out, one in. That is what keeps the ceiling a
    // ceiling rather than a ratchet.
    expect(rows).toHaveLength(2);

    const events = await rawDb
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.accountId, ACCOUNT_ID));
    expect(events.filter((e) => e.kind === "passkey_reclaimed")).toHaveLength(1);
  });

  it("rolls the delete back when a statement beside it fails", async () => {
    await seedPasskey("pk_d1_solo", "recovery", new Date());

    // The replacement insert collides on the `credential_id` UNIQUE index, which
    // is the realistic way this batch fails: an attestation the account already
    // holds. Both inserts claim the same credential id, so the second one throws.
    // D1 batches are atomic, so the delete must not survive it.
    await expect(
      commitBatch(rawDb, [
        rawDb.delete(passkeys).where(eq(passkeys.id, "pk_d1_solo")),
        seedPasskey("pk_d1_dupe", "recovery", new Date(), "d1-collides"),
        seedPasskey("pk_d1_dupe2", "recovery", new Date(), "d1-collides"),
      ]),
    ).rejects.toThrow();

    const rows = await rawDb.select().from(passkeys).where(eq(passkeys.accountId, ACCOUNT_ID));
    // The credential is still there. Without atomicity the account would be one
    // credential down with nothing to show for it.
    expect(rows.map((r) => r.id)).toContain("pk_d1_solo");
  });
});

/** `total` profiles on the seeded account, handles `<prefix>000`…, written in one request. */
const seedProfiles = async (prefix: string, total: number): Promise<string[]> => {
  const ts = new Date();
  const ids = Array.from({ length: total }, (_, i) => `usr_${prefix}_${i}`);
  await seedInWorkerd(
    ids.map((id, i) =>
      rawDb.insert(users).values({
        id,
        accountId: ACCOUNT_ID,
        handle: `${prefix}${String(i).padStart(3, "0")}`,
        displayName: null,
        avatarUrl: null,
        isDefault: false,
        createdAt: ts,
        updatedAt: ts,
      }),
    ),
  );
  return ids;
};

describe("id lists past D1's 100-parameter cap, over real D1 (Miniflare)", () => {
  it("POST /graph/internal/profile-displays returns every profile for 150 ids", async () => {
    const ids = await seedProfiles("disp", 150);
    clearPublicKeyCache();
    const keyPair = await generateArcKeyPair();
    const keyId = crypto.randomUUID();
    const serviceId = `d1-displays-${keyId.slice(0, 8)}`;
    const now = new Date();
    await rawDb
      .insert(serviceAccounts)
      .values({ serviceId, allowedScopes: "graph:read", createdAt: now, updatedAt: now });
    await rawDb.insert(serviceAccountKeys).values({
      keyId,
      serviceId,
      publicKeyJwk: await exportKeyToJwk(keyPair.publicKey),
      registeredAt: now,
      expiresAt: null,
      revokedAt: null,
    });
    const token = await createArcToken(keyPair.privateKey, {
      iss: serviceId,
      aud: "osn-api",
      scope: "graph:read",
      kid: keyId,
    });

    const res = await createInternalGraphRoutes(layer).handle(
      new Request("http://localhost/graph/internal/profile-displays", {
        method: "POST",
        headers: { Authorization: `ARC ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: ids }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: { id: string }[] };
    expect(body.profiles.map((p) => p.id).toSorted()).toEqual(ids.toSorted());
  });

  it("searchProfiles answers at limit 20 when the handle prefix matches 60 profiles", async () => {
    // The prefix pass returns 60 candidates at limit 20, and the block and
    // connection probes name the candidate list twice.
    const [caller] = await seedProfiles("caller", 1);
    await seedProfiles("pat", 61);

    const result = await run(createRecommendationService().searchProfiles(caller!, "pat", 20));

    expect(result).toHaveLength(20);
  });
});
