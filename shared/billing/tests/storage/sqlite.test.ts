import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createTestStorage } from "../support/db";
import { storageContract } from "./contract";

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
