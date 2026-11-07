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

import {
  accounts,
  oauthClients,
  organisationMembers,
  organisations,
  serviceAccountKeys,
  serviceAccounts,
  users,
} from "@osn/db/schema";
import { applySchema as applyOsnSchema } from "@osn/db/testing";
import { applySchema as applyPulseSchema } from "@pulse/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { CIRE_OIDC, CLOCK_T0, MUSUBI_ORG, PULSE_OIDC } from "./config";

/**
 * cire-api's ARC key for one run: osn-api holds the public half (`seedOsn`),
 * cire-api signs with the private half (`appSpecs`). Made fresh each run, so
 * no private key is ever written into the repository.
 */
export interface CireArcKey {
  readonly keyId: string;
  /** The private ES256 JWK, as `CIRE_API_ARC_PRIVATE_KEY` carries it. */
  readonly privateJwk: string;
  /** The public half, as osn-api stores it in `service_account_keys`. */
  readonly publicJwk: string;
}

export async function generateCireArcKey(): Promise<CireArcKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    keyId: crypto.randomUUID(),
    privateJwk: JSON.stringify({ kty, crv, x, y, d }),
    publicJwk: JSON.stringify({ kty, crv, x, y }),
  };
}

/**
 * The one scope cire-api's ARC tokens need on this stack: the owners'
 * addresses (`/internal/accounts/emails`), for its owner notices.
 */
const CIRE_API_ARC_SCOPES = "account:email-read";

function freshDatabase(path: string): Database {
  if (existsSync(path)) {
    throw new Error(`seed: ${path} already exists; the launcher clears state before seeding`);
  }
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return sqlite;
}

/** A first-party OIDC client row for osn-api's `oauth_clients`. */
function firstPartyClient(
  client: { rowId: string; clientId: string; secret: string; redirectUri: string },
  name: string,
) {
  return {
    id: client.rowId,
    clientId: client.clientId,
    name,
    redirectUris: [client.redirectUri],
    clientSecretHash: createHash("sha256").update(client.secret).digest("hex"),
    sectorIdentifier: new URL(client.redirectUri).host,
    // First-party skips consent and puts `osn_profile_id` in the ID token,
    // which is what each relying party keys its session on.
    isFirstParty: true,
    createdAt: Math.floor(CLOCK_T0 / 1000),
  };
}

/**
 * osn-api: the schema, Pulse and cire registered as first-party OIDC clients,
 * and `MUSUBI_ORG`'s member profile with the organisation it owns.
 */
export function seedOsn(path: string, cireArc?: CireArcKey): void {
  const sqlite = freshDatabase(path);
  try {
    // One transaction: on a file each autocommitted statement syncs its own journal.
    sqlite.transaction(() => {
      applyOsnSchema(sqlite);
      const db = drizzle({ client: sqlite });
      db.insert(oauthClients)
        .values([firstPartyClient(PULSE_OIDC, "Pulse"), firstPartyClient(CIRE_OIDC, "Cire")])
        .run();

      // Parents first: the connection enforces foreign keys.
      const { member, otherOrg } = MUSUBI_ORG;
      const at = new Date(CLOCK_T0);
      db.insert(accounts)
        .values({
          id: member.accountId,
          email: member.email,
          passkeyUserId: member.passkeyUserId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(users)
        .values({
          id: member.profileId,
          accountId: member.accountId,
          handle: member.handle,
          displayName: member.name,
          isDefault: true,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(organisations)
        .values({
          id: otherOrg.id,
          handle: otherOrg.handle,
          name: otherOrg.name,
          ownerId: member.profileId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(organisationMembers)
        .values({
          id: otherOrg.membershipId,
          organisationId: otherOrg.id,
          profileId: member.profileId,
          role: "admin",
          createdAt: at,
        })
        .run();

      if (cireArc) {
        db.insert(serviceAccounts)
          .values({
            serviceId: "cire-api",
            allowedScopes: CIRE_API_ARC_SCOPES,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        db.insert(serviceAccountKeys)
          .values({
            keyId: cireArc.keyId,
            serviceId: "cire-api",
            publicKeyJwk: cireArc.publicJwk,
            registeredAt: at,
          })
          .run();
      }
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
