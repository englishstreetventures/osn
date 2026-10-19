import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { origin, stageHosts } from "@shared/infra";
import { beforeAll, describe, expect, test } from "vitest";

import { arcPublicJwk, clientSecretHash, osnSeedSql, SeedInputError } from "../src/seeds";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readRepo = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

const CIRE_API_ORIGIN = origin(stageHosts("example.test", "dev").cireApi);
const ARC_KEY_ID = "0b6f8f5e-2d1c-4c7a-9f3e-5a4b3c2d1e0f";
const CLIENT_SECRET = "cs_placeholder-client-secret";

interface PrivateJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

let privateJwk = "";
let parsedPrivate: PrivateJwk;
let sql = "";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  parsedPrivate = JSON.parse(privateJwk) as PrivateJwk;
  sql = osnSeedSql({
    cireApiOrigin: CIRE_API_ORIGIN,
    clientSecret: CLIENT_SECRET,
    arcKeyId: ARC_KEY_ID,
    arcPrivateJwk: privateJwk,
  });
});

/** A fresh in-memory database migrated through osn/db's whole chain, foreign keys on as on D1. */
function migratedDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = join(repoRoot, "osn/db/drizzle");
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    for (const statement of readFileSync(join(dir, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim() !== "") db.exec(statement);
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

/** The message `run` throws. */
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

/** The scope strings in `text` that the pattern's first group captures. */
const captured = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => match[1] ?? "");

describe("osnSeedSql", () => {
  test("S1: the client row's hash is the one osn-api's own client-secret check computes", () => {
    const oidc = readRepo("osn/api/src/services/auth/oidc.ts");
    expect(oidc).toContain(
      'const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");',
    );
    expect(oidc).toMatch(
      /export function hashClientSecret\(secret: string\): string \{\s*return sha256Hex\(secret\);\s*\}/,
    );
    // SHA-256("abc"), FIPS 180-2 appendix B.1.
    expect(clientSecretHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const db = migratedDb();
    db.exec(sql);
    const row = db
      .query<ClientRow, []>("SELECT * FROM oauth_clients WHERE client_id = 'cid_cire'")
      .get();
    expect(row?.client_secret_hash).toBe(clientSecretHash(CLIENT_SECRET));
  });

  test("S2: the redirect URI is the one cire-api builds from CIRE_API_ORIGIN", () => {
    const cireApi = readRepo("cire/api/src/index.ts");
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

  test("S4: the SQL never holds a secret: not the client secret, not the private key's d", () => {
    expect(sql).not.toContain(CLIENT_SECRET);
    expect(sql).not.toContain(parsedPrivate.d);
    expect(sql).not.toContain('"d"');
  });

  test("S5: identical inputs give identical bytes", () => {
    expect(
      osnSeedSql({
        cireApiOrigin: CIRE_API_ORIGIN,
        clientSecret: CLIENT_SECRET,
        arcKeyId: ARC_KEY_ID,
        arcPrivateJwk: privateJwk,
      }),
    ).toBe(sql);
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

  test("S8: the public JWK is EC P-256 with x and y and no d, importable as ES256; any other key is refused", async () => {
    const jwk = JSON.parse(arcPublicJwk(privateJwk)) as Partial<PrivateJwk>;
    expect(jwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: parsedPrivate.x,
      y: parsedPrivate.y,
    });
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(key.type).toBe("public");

    const refused = [
      "secret-material-not-json",
      JSON.stringify({ ...parsedPrivate, kty: "RSA" }),
      JSON.stringify({ ...parsedPrivate, crv: "P-384" }),
      JSON.stringify({ kty: "EC", crv: "P-256", x: parsedPrivate.x }),
      JSON.stringify({ kty: "EC", crv: "P-256", y: parsedPrivate.y }),
      "[]",
      "null",
    ];
    for (const candidate of refused) {
      expect(() => arcPublicJwk(candidate)).toThrow(SeedInputError);
    }
    // The refusal names the secret, never its content.
    expect(
      refused.map((candidate) => thrownMessage(() => arcPublicJwk(candidate))).join("\n"),
    ).not.toMatch(new RegExp(`${parsedPrivate.d}|secret-material`));
  });

  test("S9: a value that could carry a quote into the SQL is refused", () => {
    const valid = {
      cireApiOrigin: CIRE_API_ORIGIN,
      clientSecret: CLIENT_SECRET,
      arcKeyId: ARC_KEY_ID,
      arcPrivateJwk: privateJwk,
    };
    for (const arcKeyId of ["not-a-uuid", `${ARC_KEY_ID}'`, "", `${ARC_KEY_ID} `]) {
      expect(() => osnSeedSql({ ...valid, arcKeyId })).toThrow(SeedInputError);
    }
    for (const cireApiOrigin of [
      "http://api.cire.example.test",
      "https://api.cire.example.test/",
      "https://api.cire.example.test'",
      "https://API.cire.example.test",
    ]) {
      expect(() => osnSeedSql({ ...valid, cireApiOrigin })).toThrow(SeedInputError);
    }
    for (const field of ["x", "y"] as const) {
      const quoted = JSON.stringify({ ...parsedPrivate, [field]: `${parsedPrivate[field]}'` });
      expect(() => osnSeedSql({ ...valid, arcPrivateJwk: quoted })).toThrow(SeedInputError);
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
        public_key_jwk: arcPublicJwk(privateJwk),
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
