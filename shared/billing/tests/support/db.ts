import { createDrizzleClient } from "@shared/db-utils";
import { sql } from "drizzle-orm";

import { createSqliteBillingStorage } from "../../src/storage/sqlite";
import { createBillingSqliteSchema } from "../../src/storage/sqlite-schema";
import { billingDdl } from "./ddl";

/**
 * A billing store on a fresh in-memory bun:sqlite database. `createDrizzleClient`
 * turns foreign keys on, as D1 enforces them.
 */
export async function createTestStorage(prefix = "billing_") {
  const db = await createDrizzleClient(":memory:");
  const schema = createBillingSqliteSchema({ prefix });
  for (const statement of await billingDdl(schema)) db.run(sql.raw(statement));
  return { db, schema, storage: createSqliteBillingStorage({ db, schema }) };
}
