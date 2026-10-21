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

import { CIRE_OIDC, CLOCK_T0, PULSE_OIDC } from "./config";

function freshDatabase(path: string): Database {
  if (existsSync(path)) {
    throw new Error(`seed: ${path} already exists; the launcher clears state before seeding`);
  }
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return sqlite;
}

/** A first-party relying party, as osn-api stores one: the secret only as its SHA-256. */
function firstPartyClient(
  name: string,
  client: { rowId: string; clientId: string; secret: string; redirectUri: string },
): typeof oauthClients.$inferInsert {
  return {
    id: client.rowId,
    clientId: client.clientId,
    name,
    redirectUris: [client.redirectUri],
    clientSecretHash: createHash("sha256").update(client.secret).digest("hex"),
    sectorIdentifier: new URL(client.redirectUri).host,
    // First-party skips consent and puts `osn_profile_id` in the ID token,
    // which is what Pulse and cire key their sessions on.
    isFirstParty: true,
    createdAt: Math.floor(CLOCK_T0 / 1000),
  };
}

/** osn-api: the schema, plus Pulse and cire's organiser portal as first-party OIDC clients. */
export function seedOsn(path: string): void {
  const sqlite = freshDatabase(path);
  try {
    // One transaction: on a file each autocommitted statement syncs its own journal.
    sqlite.transaction(() => {
      applyOsnSchema(sqlite);
      drizzle(sqlite)
        .insert(oauthClients)
        .values([firstPartyClient("Pulse", PULSE_OIDC), firstPartyClient("Cire", CIRE_OIDC)])
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
