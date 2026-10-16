/**
 * Builds the databases the stack boots on, with fixed rows only.
 *
 * Schemas come from each package's `applySchema`, which emits DDL from the live
 * Drizzle schema, and rows go in through typed Drizzle inserts — so a schema
 * change that breaks the seed fails `tsc` or this module, never a flow halfway
 * through. cire-api builds and seeds its own file at boot (`CIRE_LOCAL_DB_PATH`).
 *
 * Refuses to write into an existing file: a database from an earlier run carries
 * rows the flows did not expect, and they would read as this run's.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { oauthClients } from "@osn/db/schema";
import { applySchema as applyOsnSchema } from "@osn/db/testing";
import { applySchema as applyPulseSchema } from "@pulse/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { CLOCK_T0, PULSE_OIDC } from "./config";

function freshDatabase(path: string): Database {
  if (existsSync(path)) {
    throw new Error(`seed: ${path} already exists; the launcher clears state before seeding`);
  }
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return sqlite;
}

/** osn-api: the schema, plus Pulse registered as a first-party OIDC client. */
export function seedOsn(path: string): void {
  const sqlite = freshDatabase(path);
  try {
    // One transaction: on a file each autocommitted statement syncs its own journal.
    sqlite.transaction(() => {
      applyOsnSchema(sqlite);
      drizzle(sqlite)
        .insert(oauthClients)
        .values({
          id: PULSE_OIDC.rowId,
          clientId: PULSE_OIDC.clientId,
          name: "Pulse",
          redirectUris: [PULSE_OIDC.redirectUri],
          clientSecretHash: createHash("sha256").update(PULSE_OIDC.secret).digest("hex"),
          sectorIdentifier: new URL(PULSE_OIDC.redirectUri).host,
          // First-party skips consent and puts `osn_profile_id` in the ID token,
          // which is what Pulse keys its session on.
          isFirstParty: true,
          createdAt: Math.floor(CLOCK_T0 / 1000),
        })
        .run();
    })();
  } finally {
    sqlite.close();
  }
}

/** pulse-api: the schema only. The flow creates the one event it needs. */
export function seedPulse(path: string): void {
  const sqlite = freshDatabase(path);
  try {
    sqlite.transaction(() => applyPulseSchema(sqlite))();
  } finally {
    sqlite.close();
  }
}
