import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import {
  accounts,
  appEnrollments,
  deletionJobs,
  passkeys,
  recoveryCodes,
  securityEvents,
  sessions,
  users,
} from "@osn/db/schema";
import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { cancelErasure, getDeletionStatus, requestErasure } from "./services/account-erasure";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// The rest of the OSN suite runs on synchronous bun:sqlite; these exercise the
// ASYNCHRONOUS D1 driver path — specifically the multi-statement
// `commitBatch` → `db.batch([...])` branch of the account-erasure flows, which
// the bun:sqlite unit suite never reaches. This is the only coverage of the D1
// transaction-equivalent (batch) path for OSN core.
//
// NOTE: this proves the OSN *DB layer* runs on D1. Full Workers *hosting* of
// osn-api additionally needs a Workers-compatible Redis (the current ioredis
// rate-limiters / session stores don't run on Workers) — tracked in wiki/TODO.md.

/* eslint-disable no-await-in-loop */

const ACCOUNT_ID = "acc_d1test";

let mf: Miniflare;
let layer: Layer.Layer<Db>;
let rawDb: ReturnType<typeof createD1Db<typeof schema>>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

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
  const d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
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
  // writes and references `accounts` must be cleared before the account row.
  for (const table of [
    deletionJobs,
    securityEvents,
    sessions,
    passkeys,
    recoveryCodes,
    appEnrollments,
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
