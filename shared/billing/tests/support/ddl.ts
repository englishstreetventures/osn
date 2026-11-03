import { generateDrizzleJson, generateMigration } from "drizzle-kit/payload/sqlite";

import type { BillingSqliteSchema } from "../../src/storage/sqlite-schema";

/**
 * The CREATE statements `drizzle-kit generate` would write for these tables
 * into an empty database: the consumer's first migration and the test DDL come
 * from the same generator, so neither is a hand-written mirror.
 */
export async function billingDdl(schema: BillingSqliteSchema): Promise<string[]> {
  const empty = await generateDrizzleJson({});
  const current = await generateDrizzleJson({ ...schema });
  return generateMigration(empty, current);
}
