import { Database } from "bun:sqlite";

import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { EmailService, makeLogEmailLive } from "@shared/email";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";

export function createTestLayer() {
  return createTestLayerWithSqlite().layer;
}

/**
 * Same layer, plus the raw SQLite handle behind it and the email recorder
 * used to build it. Tests that need to seed a table with no route to write
 * it — the OAuth client registry, for one — insert through `sqlite` rather
 * than through a fixture the service does not have; tests that need to
 * assert on captured sends read `email.recorded()` rather than building a
 * second email layer to merge in.
 */
export function createTestLayerWithSqlite() {
  const sqlite = new Database(":memory:");
  // Emitted from the live Drizzle schema — never a hand-maintained mirror.
  // Parity with the production migration chain is enforced by
  // osn/db/tests/ddl-lockstep.test.ts.
  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
  const dbLayer = Layer.succeed(Db, { db });
  const email = makeLogEmailLive();
  return { layer: Layer.merge(dbLayer, email.layer), sqlite, db, email };
}

// Re-export for tests that want to build their own capture recorder.
export { EmailService, makeLogEmailLive };
