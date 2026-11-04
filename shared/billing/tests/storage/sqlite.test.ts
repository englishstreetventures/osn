import type { Database } from "bun:sqlite";

import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createSqliteBillingStorage } from "../../src/storage/sqlite";
import { createTestStorage } from "../support/db";
import { storageContract, subscriptionWrite } from "./contract";

storageContract("bun:sqlite", async () => createTestStorage(), { describe, it, expect });

describe("createBillingSqliteSchema", () => {
  it("prefixes every table and index, so two instances share one database", async () => {
    const { db } = await createTestStorage("billing_");
    const { createBillingSqliteSchema } = await import("../../src/storage/sqlite-schema");
    const { billingDdl } = await import("../support/ddl");
    for (const statement of await billingDdl(createBillingSqliteSchema({ prefix: "other_" }))) {
      db.run(sql.raw(statement));
    }
    const names = db
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'`,
      )
      .map((row) => row.name);
    expect(names.filter((n) => n.startsWith("other_")).length).toBe(
      names.filter((n) => n.startsWith("billing_")).length,
    );
    expect(names.every((n) => n.startsWith("other_") || n.startsWith("billing_"))).toBe(true);
  });
});

describe("forgetCustomer under a lease lost mid-call", () => {
  it("answers null and leaves every row when the lease is taken between its read and its deletes", async () => {
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
    const { db, schema, storage } = await createTestStorage();
    const now = new Date("2030-06-01T00:00:00.000Z");
    const later = (ms: number) => new Date(now.getTime() + ms);
    await run(storage.ensureCustomer("org_1", now));
    await run(storage.upsertSubscription(subscriptionWrite(), now));
    await run(storage.acquireAccess({ customerRef: "org_1", now, until: later(60_000) }));
    // The deletes are built after the lease check; another holder takes the
    // lease at that moment (bun:sqlite runs the update at once).
    let stolen = false;
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "delete" && !stolen) {
          stolen = true;
          target
            .update(schema.billingCustomers)
            .set({ accessLockUntil: later(90_000) })
            .where(eq(schema.billingCustomers.customerRef, "org_1"))
            .run();
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const forgetting = createSqliteBillingStorage({ db: racing, schema });
    expect(
      await run(forgetting.forgetCustomer({ customerRef: "org_1", token: later(60_000) })),
    ).toBeNull();
    expect(stolen).toBe(true);
    expect(await run(storage.findCustomer("org_1"))).not.toBeNull();
    expect(await run(storage.listSubscriptions("org_1"))).toHaveLength(1);
  });
});

describe("the reconcile selection's query plan", () => {
  it("seeks an index for every branch and never scans the subscriptions table", async () => {
    const { db, storage } = await createTestStorage();
    // drizzle's bun:sqlite session prepares each statement with `query`.
    const client = (db as unknown as { $client: Database }).$client;
    const seen: string[] = [];
    const query = client.query.bind(client);
    client.query = ((text: string) => {
      seen.push(text);
      return query(text);
    }) as typeof client.query;
    const now = new Date("2030-06-01T00:00:00.000Z");
    await Effect.runPromise(
      storage.listSubscriptionsToReconcile({
        now,
        limit: 10,
        attemptedBefore: now,
        unconfirmedFrom: now,
        unconfirmedTo: now,
      }),
    );
    client.query = query;
    const select = seen.find((text) => text.includes("reconciled_at"));
    expect(select).toBeDefined();
    const plan = client
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${select}`)
      .all()
      .map((row) => row.detail);
    expect(
      plan.filter((step) => step.startsWith("SEARCH billing_subscriptions USING INDEX")),
    ).toHaveLength(3);
    expect(plan.some((step) => step.startsWith("SCAN billing_subscriptions"))).toBe(false);
  });
});
