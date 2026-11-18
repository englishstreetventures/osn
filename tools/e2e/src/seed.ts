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
  appEnrollments,
  oauthClients,
  organisationMembers,
  organisations,
  passkeys,
  serviceAccountKeys,
  serviceAccounts,
  sessions,
  users,
} from "@osn/db/schema";
import { applySchema as applyOsnSchema } from "@osn/db/testing";
import { applySchema as applyPulseSchema } from "@pulse/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  CIRE_OIDC,
  CLOCK_T0,
  CIRE_REMOVAL_PERSON,
  DELETION_PERSON,
  MUSUBI_ORG,
  PULSE_OIDC,
  RECOVERY_PERSON,
  THIRD_PARTY_OIDC,
} from "./config";

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
 * The scopes cire-api's ARC tokens need on this stack: the owners' addresses
 * (`/internal/accounts/emails`), for its owner notices; and, for a host's
 * removal of their Cire data, the step-up request (`/internal/step-up/*`) and
 * the account behind a profile (`/graph/internal/profile-account`).
 */
const CIRE_API_ARC_SCOPES = "account:email-read,step-up:verify,graph:resolve-account";

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

/** `THIRD_PARTY_OIDC`'s row: a public client that always asks for consent. */
function thirdPartyClient() {
  const client = THIRD_PARTY_OIDC;
  return {
    id: client.rowId,
    clientId: client.clientId,
    name: client.name,
    redirectUris: [client.redirectUri],
    clientSecretHash: null,
    sectorIdentifier: new URL(client.redirectUri).host,
    isFirstParty: false,
    createdAt: Math.floor(CLOCK_T0 / 1000),
  };
}

/**
 * osn-api: the schema, Pulse and cire registered as first-party OIDC clients,
 * one third-party client, `MUSUBI_ORG`'s member profile with the organisation
 * it owns, `RECOVERY_PERSON` with the passkey they have lost, and
 * `DELETION_PERSON` with a Pulse enrolment, a live session and an
 * organisation whose heir holds a live session too.
 */
export function seedOsn(path: string, cireArc?: CireArcKey): void {
  const sqlite = freshDatabase(path);
  try {
    // One transaction: on a file each autocommitted statement syncs its own journal.
    sqlite.transaction(() => {
      applyOsnSchema(sqlite);
      const db = drizzle({ client: sqlite });
      db.insert(oauthClients)
        .values([
          firstPartyClient(PULSE_OIDC, "Pulse"),
          firstPartyClient(CIRE_OIDC, "Cire"),
          thirdPartyClient(),
        ])
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

      const recover = RECOVERY_PERSON;
      db.insert(accounts)
        .values({
          id: recover.accountId,
          email: recover.email,
          passkeyUserId: recover.passkeyUserId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(users)
        .values({
          id: recover.profileId,
          accountId: recover.accountId,
          handle: recover.handle,
          displayName: recover.name,
          isDefault: true,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      // Inert: no authenticator in the run holds its private key.
      db.insert(passkeys)
        .values({
          id: recover.lostPasskey.id,
          accountId: recover.accountId,
          credentialId: recover.lostPasskey.credentialId,
          publicKey: "AAAA",
          counter: 0,
          createdAt: at,
          provenanceAmr: "webauthn",
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

      const leaver = DELETION_PERSON;
      db.insert(accounts)
        .values({
          id: leaver.accountId,
          email: leaver.email,
          passkeyUserId: leaver.passkeyUserId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(users)
        .values({
          id: leaver.profileId,
          accountId: leaver.accountId,
          handle: leaver.handle,
          displayName: leaver.name,
          isDefault: true,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      const atSec = Math.floor(CLOCK_T0 / 1000);
      db.insert(appEnrollments)
        .values({
          id: leaver.enrolmentId,
          accountId: leaver.accountId,
          app: "pulse",
          joinedAt: atSec,
        })
        .run();

      // Its organisation: the heir, an admin, joined before the member.
      for (const other of [leaver.heir, leaver.member]) {
        db.insert(accounts)
          .values({
            id: other.accountId,
            email: other.email,
            passkeyUserId: other.passkeyUserId,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        db.insert(users)
          .values({
            id: other.profileId,
            accountId: other.accountId,
            handle: other.handle,
            displayName: other.name,
            isDefault: true,
            createdAt: at,
            updatedAt: at,
          })
          .run();
      }
      db.insert(organisations)
        .values({
          id: leaver.organisation.id,
          handle: leaver.organisation.handle,
          name: leaver.organisation.name,
          ownerId: leaver.profileId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      const members = [
        { profileId: leaver.profileId, role: "admin" as const, joined: 0 },
        { profileId: leaver.heir.profileId, role: "admin" as const, joined: 1 },
        { profileId: leaver.member.profileId, role: "member" as const, joined: 2 },
      ];
      for (const m of members) {
        db.insert(organisationMembers)
          .values({
            id: `orgm_e2e_leaver_${m.joined}`,
            organisationId: leaver.organisation.id,
            profileId: m.profileId,
            role: m.role,
            createdAt: new Date(CLOCK_T0 + m.joined * 1000),
          })
          .run();
      }

      // `cire-remove-my-data`'s two people: the remover, signed in to Musubi,
      // and the keeper, who is mailed when the remover leaves their wedding.
      const remover = CIRE_REMOVAL_PERSON;
      for (const person of [remover, remover.keeper]) {
        db.insert(accounts)
          .values({
            id: person.accountId,
            email: person.email,
            passkeyUserId: person.passkeyUserId,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        db.insert(users)
          .values({
            id: person.profileId,
            accountId: person.accountId,
            handle: person.handle,
            displayName: person.name,
            isDefault: true,
            createdAt: at,
            updatedAt: at,
          })
          .run();
      }

      // Sessions as a sign-in leaves them: the row holds the token's SHA-256,
      // never the token. Each lasts the run (the suite clock starts at
      // `CLOCK_T0`), and its first grant rotates it as any other.
      for (const [accountId, session] of [
        [leaver.accountId, leaver.session],
        [leaver.heir.accountId, leaver.heir.session],
        [remover.accountId, remover.session],
      ] as const) {
        db.insert(sessions)
          .values({
            id: createHash("sha256").update(session.token).digest("hex"),
            accountId,
            familyId: session.familyId,
            createdAt: atSec,
            authenticatedAt: atSec,
            expiresAt: atSec + 30 * 24 * 60 * 60,
          })
          .run();
      }
    })();
  } finally {
    sqlite.close();
  }
}

/** pulse-api: the schema only. The flow creates every row it reads. */
export function seedPulse(path: string): void {
  const sqlite = freshDatabase(path);
  try {
    sqlite.transaction(() => applyPulseSchema(sqlite))();
  } finally {
    sqlite.close();
  }
}
