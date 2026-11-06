import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, registrySettings, weddingHosts, weddings } from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { registryService } from "../../src/services/registry";
import { ownerSeat } from "../test-helpers/wedding";

// A Stripe account can take gifts for several weddings, and Stripe's account
// events name the account, never a wedding: `account.updated` and a
// deauthorization write every `registry_settings` row naming it. Those writes,
// the list of an owner's accounts and the reuse that gives a wedding one must
// each reach their rows by an index — the partial
// `registry_settings_stripe_account_idx`, a primary key, or a seat index — or
// each reads every wedding's settings. These run each statement and check
// SQLite's plan for it: no full scan of the settings or the seats.

interface Captured {
  sql: string;
  params: unknown[];
}

/** Every statement the client runs from here on, with the values bound to it. */
function capture(db: TestDb): Captured[] {
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  const seen: Captured[] = [];
  Object.defineProperty(client, "query", {
    configurable: true,
    value: (sql: string) => {
      const statement = prepare(sql);
      for (const method of ["all", "values", "run", "get"] as const) {
        const original = statement[method].bind(statement) as (...p: unknown[]) => unknown;
        Object.defineProperty(statement, method, {
          configurable: true,
          value: (...params: unknown[]) => {
            seen.push({ sql, params });
            return original(...params);
          },
        });
      }
      return statement;
    },
  });
  return seen;
}

/** The plan lines that read the settings or the seats (or an alias) in full. */
function fullScans(db: TestDb, statements: readonly Captured[]): string[] {
  const scans: string[] = [];
  for (const { sql, params } of statements) {
    // `prepare`, not `query`: `capture` shadows `query`.
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[])) as Array<{ detail: string }>;
    for (const { detail } of plan) {
      if (
        /^SCAN (registry_settings|wedding_hosts|src|seat|mine|theirs|ts|mine_seat)\b/.test(detail)
      ) {
        scans.push(`${detail}  ←  ${sql.slice(0, 80)}`);
      }
    }
  }
  return scans;
}

const OWNER = "usr_dev_bootstrap_owner";
const SOURCE = "wed_index_source";
const SHARED = "acct_index_shared";

/** The bootstrap wedding and another its owner owns, whose account they connected. */
function seeded(): TestDb {
  const db = createDb(":memory:");
  // No ANALYZE: without statistics the planner costs indexes by their shape,
  // the same as a D1 database nobody has analysed.
  seedDb(db);
  const now = new Date();
  db.insert(weddings)
    .values({
      id: SOURCE,
      slug: "index-source",
      displayName: "Source",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values(ownerSeat(SOURCE, OWNER, now))
    .run();
  db.insert(registrySettings)
    .values({
      weddingId: SOURCE,
      stripeAccountId: SHARED,
      stripeConnectedByOsnProfileId: OWNER,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDefaultCurrency: "AUD",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

const run = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(DbService, db)));

describe("Stripe account statements reach their rows by an index", () => {
  it("for the list, the reuse, its refusal, and both webhook writes", async () => {
    const db = seeded();
    const seen = capture(db);

    await run(db, registryService.reusableStripeAccounts(BOOTSTRAP_WEDDING_ID, OWNER));
    await run(
      db,
      registryService.adoptStripeAccount(BOOTSTRAP_WEDDING_ID, SOURCE, OWNER, {
        takesPayments: true,
      }),
    );
    // Again: the wedding has the account now, so this one is refused and pays
    // for the failure-path read too.
    await run(
      db,
      registryService.adoptStripeAccount(BOOTSTRAP_WEDDING_ID, SOURCE, OWNER, {
        takesPayments: true,
      }),
    );
    await run(
      db,
      registryService.applyStripeAccountState({
        id: SHARED,
        chargesEnabled: false,
        payoutsEnabled: false,
      }),
    );
    await run(db, registryService.detachStripeAccount({ accountId: SHARED }));

    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(fullScans(db, seen)).toEqual([]);
  });

  it("reaches the account's rows through the partial index", () => {
    const db = seeded();
    const plan = db.$client
      .prepare(
        "EXPLAIN QUERY PLAN UPDATE registry_settings SET stripe_charges_enabled = 0 WHERE stripe_account_id = ?",
      )
      .all(SHARED) as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join("\n")).toContain("registry_settings_stripe_account_idx");
  });
});
