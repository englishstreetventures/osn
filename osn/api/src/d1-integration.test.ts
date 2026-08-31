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
import { Cause, Effect, Layer, Option, Runtime } from "effect";
import { Miniflare } from "miniflare";

import { UNIQUE_CONSTRAINT_ERROR } from "./lib/unique-constraint";
import { cancelErasure, getDeletionStatus, requestErasure } from "./services/account-erasure";
import { createRecommendationService } from "./services/recommendations";

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
  it("suggestConnections throws once the caller's accepted-connection count pushes the FOF query past D1's 100-bound-parameter cap", async () => {
    // The FOF fan-out (services/recommendations.ts) binds `myConnectionIds`
    // TWICE — once per edge direction, in
    // `inArray(requesterId, ids) OR inArray(addresseeId, ids)`.
    // MAX_MY_CONNECTIONS_FOR_FOF allows up to 500 ids (1 000 binds), but D1's
    // documented cap is 100 bound parameters per query
    // (developers.cloudflare.com/d1/platform/limits/: "Maximum bound
    // parameters per query | 100", applying per statement including within a
    // batch). 51 accepted connections already produces 102 binds — over the
    // cap — so `GET /recommendations/connections` already fails in
    // production for any caller with more than 50 accepted connections.
    //
    // Confirmed empirically against THIS Miniflare version before writing
    // this test: it enforces the same 100-parameter cap D1 documents (100
    // bound params succeeds, 101 throws "too many SQL variables"), so this
    // is real coverage of the failure, not a false negative that only
    // production would catch.
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

    const FRIEND_COUNT = 60; // 2 x 60 = 120 binds, over D1's 100-bind cap
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

    const recs = createRecommendationService();
    let threw = false;
    let message = "";
    try {
      await run(recs.suggestConnections(callerId));
    } catch (e) {
      threw = true;
      // The Effect error channel wraps three deep here: the service's own
      // `DatabaseError`, wrapping drizzle's `DrizzleQueryError`, wrapping the
      // real `D1_ERROR: too many SQL variables …` — walk `.cause` down to the
      // bottom rather than asserting on the generic outer message.
      // `Effect.runPromise` rejects with a `FiberFailure` wrapping the typed
      // failure, never the tagged error itself — same unwrap `safe-error.ts`
      // does for route handlers (Runtime.isFiberFailure → Cause.failureOption).
      const failure = Runtime.isFiberFailure(e)
        ? Option.getOrNull(Cause.failureOption(e[Runtime.FiberFailureCauseId]))
        : e;
      let cause: unknown = failure;
      for (let depth = 0; depth < 5; depth++) {
        const next = (cause as { cause?: unknown } | undefined)?.cause;
        if (next === undefined || next === null) break;
        cause = next;
      }
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(threw).toBe(true);
    expect(message).toContain("too many SQL variables");
  });
});
