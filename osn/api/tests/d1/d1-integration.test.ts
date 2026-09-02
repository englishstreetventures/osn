import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

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
  sessions,
  users,
} from "@osn/db/schema";
import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { commitBatch, createD1Db } from "@shared/db-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { UNIQUE_CONSTRAINT_ERROR } from "../../src/lib/unique-constraint";
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
//
// NOTE: this proves the OSN *DB layer* runs on D1. Full Workers *hosting* of
// osn-api additionally needs a Workers-compatible Redis (the current ioredis
// rate-limiters / session stores don't run on Workers) — tracked as an open issue.

/* eslint-disable no-await-in-loop */

const ACCOUNT_ID = "acc_d1test";

let mf: Miniflare;
let d1: DrizzleD1;
let layer: Layer.Layer<Db>;
let rawDb: ReturnType<typeof createD1Db<typeof schema>>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

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
 * This is the test seam for S-H1 (osn-tracker#589 follow-up): the race it
 * fixes needs a real write to land in the gap between `suggestConnections`'s
 * step 1 (`myEdgeRows`, a snapshot) and step 2 (the FOF fan-out, whose seed
 * subquery reads `connections` live) — a gap with a genuine D1 round trip in
 * it, not something a single in-process call can reproduce by itself.
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
    script: "export default { fetch() { return new Response('ok'); } };",
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
    // osn-tracker#574. MAX_ORG_COMEMBER_ROWS (services/recommendations.ts) is
    // 2 000, split evenly across the caller's organisations. Seeding a single
    // organisation the caller belongs to gives that organisation the *whole*
    // budget as its share, so proving the cap requires seeding upwards of
    // 2 000 members regardless of fixture size — that was the original form
    // of this test, and it cost ~4.8s, nearly all of it seeding 2 500 rows
    // through three FK-linked tables (osn-tracker#589 / P-W1).
    //
    // Putting the caller in ORG_COUNT organisations instead shrinks each
    // one's share to `MAX_ORG_COMEMBER_ROWS / ORG_COUNT`, so the same "far
    // more members than its share" property needs far fewer seeded rows:
    // with 10 organisations the share is 200, and 500 members in the one
    // oversized organisation is already 2.5x its share — a clear violation
    // for the fan-out to cap, at a fifth of the previous row count. The other
    // nine organisations need no extra members; the caller's own membership
    // row is enough to exercise their arm of the fan-out.
    const callerId = "usr_boundtest_caller";
    const callerAccountId = "acc_boundtest_caller";
    const ts = new Date();
    await rawDb.insert(accounts).values({
      id: callerAccountId,
      email: "boundtest-caller@example.com",
      passkeyUserId: crypto.randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(users).values({
      id: callerId,
      accountId: callerAccountId,
      handle: "boundtest_caller",
      createdAt: ts,
      updatedAt: ts,
    });

    const ORG_COUNT = 10;
    const OVERSIZED_ORG_ID = "org_boundtest_0";
    for (let i = 0; i < ORG_COUNT; i++) {
      const organisationId = `org_boundtest_${i}`;
      // eslint-disable-next-line no-await-in-loop -- sequential, FK-ordered seeding
      await rawDb.insert(organisations).values({
        id: organisationId,
        handle: `boundtest${i}`,
        name: `Bound Test Org ${i}`,
        ownerId: callerId,
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(organisationMembers).values({
        id: `orgm_boundtest_caller_${i}`,
        organisationId,
        profileId: callerId,
        role: "admin",
        createdAt: ts,
      });
    }

    // D1 caps bound parameters at 100 PER STATEMENT (see the FOF test below),
    // so a multi-row `INSERT ... VALUES (...), (...), …` — one statement,
    // many binds — hits that cap almost immediately at these row widths.
    // `commitBatch` (already used above, `@shared/db-utils`) sends many
    // single-row statements as one D1 `batch()` round trip instead: each
    // statement stays far under the per-statement cap, and the batch itself
    // is still one network hop.
    const MEMBER_COUNT = 500;
    const BATCH = 100;
    for (let i = 0; i < MEMBER_COUNT; i += BATCH) {
      const indices = Array.from({ length: Math.min(BATCH, MEMBER_COUNT - i) }, (_, j) => i + j);
      // eslint-disable-next-line no-await-in-loop -- sequential batches; each
      // depends on nothing but must land before the assertions below run.
      await commitBatch(
        rawDb,
        indices.map((n) =>
          rawDb.insert(accounts).values({
            id: `acc_boundtest_m${n}`,
            email: `boundtest-m${n}@example.com`,
            passkeyUserId: crypto.randomUUID(),
            createdAt: ts,
            updatedAt: ts,
          }),
        ),
      );
      // eslint-disable-next-line no-await-in-loop
      await commitBatch(
        rawDb,
        indices.map((n) =>
          rawDb.insert(users).values({
            id: `usr_boundtest_m${n}`,
            accountId: `acc_boundtest_m${n}`,
            handle: `boundtestm${n}`,
            createdAt: ts,
            updatedAt: ts,
          }),
        ),
      );
      // eslint-disable-next-line no-await-in-loop
      await commitBatch(
        rawDb,
        indices.map((n) =>
          rawDb.insert(organisationMembers).values({
            id: `orgm_boundtest_m${n}`,
            organisationId: OVERSIZED_ORG_ID,
            profileId: `usr_boundtest_m${n}`,
            role: "member" as const,
            createdAt: ts,
          }),
        ),
      );
    }

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

  it("does not throw for a caller in 6 organisations — the exact arm count the removed comment claimed was safe", async () => {
    // osn-tracker#589 (P-C1). The co-member fan-out used to be one `UNION
    // ALL` of one arm per organisation the caller belongs to, and a removed
    // comment claimed that was safe because `MAX_MY_ORGANISATIONS` (50) sits
    // "well under SQLite's 500-term compound-select limit". That figure is
    // right for `bun:sqlite` and wrong for the engine this actually runs
    // on: D1 runs on workerd's embedded SQLite, which caps a compound
    // `SELECT` at 5 terms (`MAX_ORG_COMEMBER_ARMS_PER_QUERY`, see its
    // comment in services/recommendations.ts) — so the single-statement
    // form threw `D1_ERROR: too many terms in compound SELECT` for any
    // caller in 6 or more organisations. This seeds exactly that caller —
    // 6 organisations, one arm each — and asserts `suggestConnections`
    // succeeds. Revert the batching in `services/recommendations.ts` and
    // this test is the one that goes red.
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
  it("suggestConnections succeeds well past the caller's accepted-connection count that used to push the FOF query over D1's 100-bound-parameter cap", async () => {
    // Was: the FOF fan-out (services/recommendations.ts) bound
    // `myConnectionIds` TWICE — once per edge direction, in
    // `inArray(requesterId, ids) OR inArray(addresseeId, ids)`. D1's
    // documented cap is 100 bound parameters per query
    // (developers.cloudflare.com/d1/platform/limits/: "Maximum bound
    // parameters per query | 100", applying per statement including within a
    // batch), so 51 accepted connections already produced 102 binds and threw
    // `D1_ERROR: too many SQL variables` — a real production failure for any
    // caller past 50 accepted connections (osn-tracker#589).
    //
    // Fixed by binding `profileId` instead of the id list: the FOF query now
    // reads the caller's own accepted edges through a correlated `IN
    // (<subquery>)` rather than pasting them in as literals, so its bind
    // count is fixed regardless of how many connections the caller has — see
    // the query in services/recommendations.ts for the full account,
    // including why a correlated `EXISTS` (D1's plan showed a full table
    // scan) was measured and rejected in favour of this shape.
    //
    // This test keeps the same 60-accepted-connection fixture the
    // characterisation test used — well past the old 50-connection cliff,
    // and confirmed empirically against this Miniflare version to still
    // enforce D1's 100-bound-parameter cap the old shape blew through — and
    // now asserts the call succeeds and returns real friend-of-friend
    // suggestions, over real (Miniflare/workerd) D1.
    const callerId = "usr_bindtest_caller";
    const callerAccountId = "acc_bindtest_caller";
    const ts = new Date();
    await rawDb.insert(accounts).values({
      id: callerAccountId,
      email: "bindtest-caller@example.com",
      passkeyUserId: crypto.randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    });
    await rawDb.insert(users).values({
      id: callerId,
      accountId: callerAccountId,
      handle: "bindtest_caller",
      createdAt: ts,
      updatedAt: ts,
    });

    const FRIEND_COUNT = 60; // 2 x 60 = 120 binds under the old shape, over D1's 100-bind cap
    for (let i = 0; i < FRIEND_COUNT; i++) {
      const friendAccountId = `acc_bindtest_f${i}`;
      const friendId = `usr_bindtest_f${i}`;
      // eslint-disable-next-line no-await-in-loop -- sequential, FK-ordered seeding
      await rawDb.insert(accounts).values({
        id: friendAccountId,
        email: `bindtest-f${i}@example.com`,
        passkeyUserId: crypto.randomUUID(),
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(users).values({
        id: friendId,
        accountId: friendAccountId,
        handle: `bindtestf${i}`,
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(connections).values({
        id: `conn_bindtest_${i}`,
        requesterId: callerId,
        addresseeId: friendId,
        status: "accepted",
        createdAt: ts,
        updatedAt: ts,
      });
    }

    // A handful of the caller's friends each have one connection of their
    // own beyond the caller — real friend-of-friend candidates, so this
    // proves the query returns *correct* suggestions past the old cliff, not
    // merely that it avoids throwing.
    const FOF_CANDIDATE_COUNT = 3;
    for (let i = 0; i < FOF_CANDIDATE_COUNT; i++) {
      const candidateAccountId = `acc_bindtest_fof${i}`;
      const candidateId = `usr_bindtest_fof${i}`;
      // eslint-disable-next-line no-await-in-loop -- sequential, FK-ordered seeding
      await rawDb.insert(accounts).values({
        id: candidateAccountId,
        email: `bindtest-fof${i}@example.com`,
        passkeyUserId: crypto.randomUUID(),
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(users).values({
        id: candidateId,
        accountId: candidateAccountId,
        handle: `bindtestfof${i}`,
        createdAt: ts,
        updatedAt: ts,
      });
      // eslint-disable-next-line no-await-in-loop
      await rawDb.insert(connections).values({
        id: `conn_bindtest_fof_${i}`,
        requesterId: `usr_bindtest_f${i}`, // one of the caller's direct friends
        addresseeId: candidateId,
        status: "accepted",
        createdAt: ts,
        updatedAt: ts,
      });
    }

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

  it("does not suggest a connection the caller accepted, in a second in-flight request, between step 1 and the FOF fan-out (S-H1)", async () => {
    // osn-tracker#589 follow-up. `suggestConnections` reads the caller's own
    // context in two separate, un-transacted D1 round trips: step 1
    // (`myEdgeRows`, a snapshot) and step 2 (the FOF fan-out, whose seed
    // subquery re-reads `connections` live). If the caller accepts a new
    // connection in the gap between them — the same account, a second
    // request in flight from another tab or device — that connection's id
    // was never seen by step 1's snapshot, so it lands in neither
    // `myConnectionIdSet` nor `excludeIds`, but the live seed subquery sees
    // it. Before the fix, the fan-out row for that brand-new edge was
    // misclassified as a candidate rather than a mutual connection, and
    // nothing downstream re-checked it: the caller's own newest connection
    // came back as "someone you may know."
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
    // "someone you may know" — that is the S-H1 fix.
    const suggestedHandles = suggestions.map((s) => s.handle);
    expect(suggestedHandles).not.toContain("racetest_late");
  });
});
