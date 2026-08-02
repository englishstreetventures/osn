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
 * Same layer, plus the raw SQLite handle behind it. Tests that need to seed a
 * table with no route to write it — the OAuth client registry, for one — insert
 * through this handle rather than through a fixture the service does not have.
 */
export function createTestLayerWithSqlite() {
  const sqlite = new Database(":memory:");
  // Emitted from the live Drizzle schema — never a hand-maintained mirror.
  // Parity with the production migration chain is enforced by
  // osn/db/tests/ddl-lockstep.test.ts.
  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
  const dbLayer = Layer.succeed(Db, { db });
  const emailLayer = makeLogEmailLive().layer;
  return { layer: Layer.merge(dbLayer, emailLayer), sqlite, db };
}

/**
 * Variant of `createTestLayer()` that exposes the email recorder so
 * tests can assert on captured sends. Replaces the old pattern of
 * setting a `sendEmail` callback in `AuthConfig`.
 */
export function createTestLayerWithEmailRecorder() {
  const inner = createTestLayer();
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(inner, email.layer),
    recorded: email.recorded,
    reset: email.reset,
  };
}

// Re-export for tests that want to build their own capture recorder.
export { EmailService, makeLogEmailLive };
