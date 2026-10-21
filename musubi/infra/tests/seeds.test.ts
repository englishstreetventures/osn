import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { origin, stageHosts } from "@shared/infra";
import { beforeAll, describe, expect, test } from "vitest";

import { listMigrations, migrationStatements } from "../../../scripts/migration-files";
import { osnSeedSql, SeedInputError } from "../src/seeds";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readRepo = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

const CIRE_API_ORIGIN = origin(stageHosts("example.test", "dev").cireApi);
const ARC_KEY_ID = "0b6f8f5e-2d1c-4c7a-9f3e-5a4b3c2d1e0f";
/**
 * SHA-256("abc"), FIPS 180-2 appendix B.1: a hash of the shape the cire_seed
 * step writes for the client secret.
 */
const CLIENT_SECRET_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
}

/** The public half as the cire_seed step writes it: kty, crv, x and y only. */
let publicJwk = "";
let parsedPublic: PublicJwk;
/** The private key's `d`, which the seed must refuse to carry. */
let privateD = "";
let sql = "";

const seedOf = (overrides: Partial<Parameters<typeof osnSeedSql>[0]> = {}): string =>
  osnSeedSql({
    cireApiOrigin: CIRE_API_ORIGIN,
    clientSecretSha256: CLIENT_SECRET_SHA256,
    arcKeyId: ARC_KEY_ID,
    arcPublicJwk: publicJwk,
    ...overrides,
  });

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  parsedPublic = {
    kty: exported.kty ?? "",
    crv: exported.crv ?? "",
    x: exported.x ?? "",
    y: exported.y ?? "",
  };
  publicJwk = JSON.stringify(parsedPublic);
  privateD = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d ?? "";
  sql = seedOf();
});

/** A fresh in-memory database migrated through osn/db's whole chain, foreign keys on as on D1. */
function migratedDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = join(repoRoot, "osn/db/drizzle");
  for (const file of listMigrations(dir)) {
    for (const statement of migrationStatements(readFileSync(join(dir, file), "utf8"))) {
      db.exec(statement);
    }
  }
  return db;
}

interface ClientRow {
  readonly client_id: string;
  readonly redirect_uris: string;
  readonly client_secret_hash: string;
  readonly sector_identifier: string;
  readonly allowed_scopes: string;
  readonly is_first_party: number;
  readonly disabled_at: number | null;
}

interface KeyRow {
  readonly key_id: string;
  readonly service_id: string;
  readonly public_key_jwk: string;
  readonly registered_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
}

/** The error `run` throws. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

/** The scope strings in `text` that the pattern's first group captures. */
const captured = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => match[1] ?? "");

describe("osnSeedSql", () => {
  test("S1: the client row holds the client secret's hash as given", () => {
    const db = migratedDb();
    db.exec(sql);
    const row = db
      .query<ClientRow, []>("SELECT * FROM oauth_clients WHERE client_id = 'cid_cire'")
      .get();
    expect(row?.client_secret_hash).toBe(CLIENT_SECRET_SHA256);
  });

  test("S2: the redirect URI is the one cire-api builds from CIRE_API_ORIGIN", () => {
    const cireApi = readRepo("cire/api/src/lib/oidc.ts");
    expect(cireApi).toMatch(/const apiOrigin = env\.CIRE_API_ORIGIN\b/);
    const path = /redirectUri: `\$\{apiOrigin\}([^`]+)`/.exec(cireApi)?.[1];
    expect(path).toBe("/api/auth/oidc/callback");
    const db = migratedDb();
    db.exec(sql);
    const row = db
      .query<ClientRow, []>("SELECT * FROM oauth_clients WHERE client_id = 'cid_cire'")
      .get();
    expect(JSON.parse(row?.redirect_uris ?? "null")).toEqual([`${CIRE_API_ORIGIN}${path}`]);
  });

  test("S5: identical inputs give identical bytes", () => {
    expect(seedOf()).toBe(sql);
  });

  test("S7: cire-api's service account carries exactly the scopes cire-api requests, each one osn-api permits", () => {
    const requested = captured(
      readRepo("cire/api/src/services/osn-bridge.ts"),
      /const ARC_\w*SCOPE = "([^"]+)"/g,
    );
    const permittedBlock =
      /const PERMITTED_SCOPES = new Set\(\[([\s\S]*?)\]\)/.exec(
        readRepo("osn/api/src/routes/graph-internal.ts"),
      )?.[1] ?? "";
    const permitted = captured(permittedBlock, /"([^"]+)"/g);
    expect(requested.length).toBeGreaterThan(0);

    const db = migratedDb();
    db.exec(sql);
    const account = db
      .query<{ allowed_scopes: string }, []>(
        "SELECT allowed_scopes FROM service_accounts WHERE service_id = 'cire-api'",
      )
      .get();
    const granted = (account?.allowed_scopes ?? "").split(",");
    expect(granted.toSorted()).toEqual(requested.toSorted());
    expect(granted.filter((scope) => !permitted.includes(scope))).toEqual([]);
  });

  test("S8: the key row holds the public JWK's kty, crv, x and y; a key that is not EC P-256 with x and y, or that carries d, is refused", () => {
    // Extra public members are dropped, so the row is the same whatever
    // exported the key.
    for (const given of [publicJwk, JSON.stringify({ ...parsedPublic, ext: true })]) {
      const db = migratedDb();
      db.exec(seedOf({ arcPublicJwk: given }));
      const key = db
        .query<KeyRow, []>(`SELECT * FROM service_account_keys WHERE key_id = '${ARC_KEY_ID}'`)
        .get();
      expect(key?.public_key_jwk).toBe(publicJwk);
    }

    const refused = [
      "key-material-not-json",
      JSON.stringify({ ...parsedPublic, d: privateD }),
      JSON.stringify({ ...parsedPublic, kty: "RSA" }),
      JSON.stringify({ ...parsedPublic, crv: "P-384" }),
      JSON.stringify({ kty: "EC", crv: "P-256", x: parsedPublic.x }),
      JSON.stringify({ kty: "EC", crv: "P-256", y: parsedPublic.y }),
      "[]",
      "null",
    ];
    for (const arcPublicJwk of refused) {
      const error = thrown(() => seedOf({ arcPublicJwk }));
      expect(error).toBeInstanceOf(SeedInputError);
      expect(error).toMatchObject({ input: "CIRE_API_ARC_PUBLIC_JWK" });
      // The refusal names the value, never its content.
      expect(String((error as SeedInputError).message)).not.toMatch(
        new RegExp(`${privateD}|key-material`),
      );
    }
  });

  test("S9: a value that could carry a quote into the SQL is refused", () => {
    for (const arcKeyId of ["not-a-uuid", `${ARC_KEY_ID}'`, "", `${ARC_KEY_ID} `]) {
      expect(() => seedOf({ arcKeyId })).toThrow(SeedInputError);
    }
    for (const cireApiOrigin of [
      "http://api.cire.example.test",
      "https://api.cire.example.test/",
      "https://api.cire.example.test'",
      "https://API.cire.example.test",
    ]) {
      expect(() => seedOf({ cireApiOrigin })).toThrow(SeedInputError);
    }
    for (const clientSecretSha256 of [
      `${CLIENT_SECRET_SHA256.slice(0, 63)}'`,
      CLIENT_SECRET_SHA256.toUpperCase(),
      CLIENT_SECRET_SHA256.slice(1),
      "",
    ]) {
      expect(() => seedOf({ clientSecretSha256 })).toThrow(SeedInputError);
    }
    for (const field of ["x", "y"] as const) {
      const quoted = JSON.stringify({ ...parsedPublic, [field]: `${parsedPublic[field]}'` });
      expect(() => seedOf({ arcPublicJwk: quoted })).toThrow(SeedInputError);
    }
  });

  describe("S10: re-importing the seed never undoes what an operator did in the database", () => {
    const keyRow = (db: Database): KeyRow | null =>
      db
        .query<KeyRow, []>(`SELECT * FROM service_account_keys WHERE key_id = '${ARC_KEY_ID}'`)
        .get();
    const clientRow = (db: Database): ClientRow | null =>
      db.query<ClientRow, []>("SELECT * FROM oauth_clients WHERE client_id = 'cid_cire'").get();

    test("a fresh database gets the client, the service account and the key, live", () => {
      const db = migratedDb();
      db.exec(sql);
      expect(clientRow(db)).toMatchObject({
        sector_identifier: "cireweddings.com",
        allowed_scopes: "openid profile email",
        is_first_party: 1,
        disabled_at: null,
      });
      expect(
        db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM service_accounts WHERE service_id = 'cire-api'",
          )
          .get()?.n,
      ).toBe(1);
      expect(keyRow(db)).toEqual({
        key_id: ARC_KEY_ID,
        service_id: "cire-api",
        public_key_jwk: publicJwk,
        // 2025-10-17T00:00:00Z, the instant every seeded row records.
        registered_at: 1760659200,
        expires_at: null,
        revoked_at: null,
      });
    });

    test.each([
      ["revoked_at", "revoked_at = 1700000300"],
      ["expires_at", "expires_at = 1700000600"],
    ])("a cire-api key with %s set keeps it after two imports", (_, change) => {
      const db = migratedDb();
      db.exec(sql);
      db.exec(`UPDATE service_account_keys SET ${change} WHERE key_id = '${ARC_KEY_ID}'`);
      const before = keyRow(db);
      expect(before?.revoked_at ?? before?.expires_at).not.toBeNull();

      db.exec(sql);
      db.exec(sql);

      expect(keyRow(db)).toEqual(before);
    });

    test("a disabled cid_cire stays disabled after two imports", () => {
      const db = migratedDb();
      db.exec(sql);
      db.exec("UPDATE oauth_clients SET disabled_at = 1700000300 WHERE client_id = 'cid_cire'");

      db.exec(sql);
      db.exec(sql);

      expect(clientRow(db)?.disabled_at).toBe(1700000300);
    });

    test("a key id another service holds stays that service's, its public key unchanged", () => {
      const db = migratedDb();
      db.exec(`INSERT INTO service_accounts (service_id, allowed_scopes, created_at, updated_at)
        VALUES ('zap-api', 'graph:read', 1700000000, 1700000000)`);
      db.exec(`INSERT INTO service_account_keys (key_id, service_id, public_key_jwk, registered_at, expires_at, revoked_at)
        VALUES ('${ARC_KEY_ID}', 'zap-api', '{"kty":"EC"}', 1700000000, NULL, NULL)`);

      db.exec(sql);
      db.exec(sql);

      expect(keyRow(db)).toEqual({
        key_id: ARC_KEY_ID,
        service_id: "zap-api",
        public_key_jwk: '{"kty":"EC"}',
        registered_at: 1700000000,
        expires_at: null,
        revoked_at: null,
      });
    });
  });
});
