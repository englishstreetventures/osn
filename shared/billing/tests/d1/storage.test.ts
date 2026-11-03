import { afterAll, describe, expect, it } from "bun:test";

import { createD1Db } from "@shared/db-utils";
import { Miniflare } from "miniflare";

import { createSqliteBillingStorage } from "../../src/storage/sqlite";
import { createBillingSqliteSchema } from "../../src/storage/sqlite-schema";
import { storageContract, type Runner } from "../storage/contract";
import { billingDdl } from "../support/ddl";

/**
 * The storage contract on real D1 semantics (workerd through Miniflare): the
 * driver whose result shapes, batch transactions and foreign keys bun:sqlite
 * does not reproduce. One database for the file, emptied before each case.
 */

const schema = createBillingSqliteSchema();
let mf: Miniflare | undefined;
let ready: Promise<D1Database> | undefined;

const boot = () =>
  (ready ??= (async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
      d1Databases: { DB: ":memory:" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const statement of await billingDdl(schema)) await d1.prepare(statement).run();
    return d1;
  })());

afterAll(async () => {
  await mf?.dispose();
});

storageContract(
  "Miniflare D1",
  async () => {
    const d1 = await boot();
    // Children before parents: D1 enforces the foreign keys.
    for (const table of [
      "billing_grants",
      "billing_subscriptions",
      "billing_webhook_events",
      "billing_customers",
    ]) {
      await d1.prepare(`DELETE FROM "${table}"`).run();
    }
    return { storage: createSqliteBillingStorage({ db: createD1Db(d1), schema }) };
  },
  { describe, it, expect } as unknown as Runner,
);
