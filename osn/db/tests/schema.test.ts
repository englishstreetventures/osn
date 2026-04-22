import { Database } from "bun:sqlite";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      passkey_user_id TEXT NOT NULL UNIQUE,
      max_profiles INTEGER NOT NULL DEFAULT 5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE passkeys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at INTEGER NOT NULL,
      label TEXT,
      last_used_at INTEGER,
      aaguid TEXT,
      backup_eligible INTEGER,
      backup_state INTEGER,
      updated_at INTEGER
    )
  `);
  sqlite.run(`
    CREATE TABLE service_accounts (
      service_id TEXT PRIMARY KEY,
      allowed_scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE service_account_keys (
      key_id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES service_accounts(service_id),
      public_key_jwk TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("accounts schema", () => {
  it("inserts and retrieves an account", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.accounts).values({
      id: "acc_test",
      email: "test@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, "acc_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("acc_test");
    expect(row.email).toBe("test@example.com");
    expect(row.maxProfiles).toBe(5);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique email constraint", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values({
      id: "acc_a",
      email: "dup@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      db.insert(schema.accounts).values({
        id: "acc_b",
        email: "dup@example.com",
        passkeyUserId: crypto.randomUUID(),
        maxProfiles: 5,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });
});

describe("users schema", () => {
  it("inserts and retrieves a row", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.accounts).values({
      id: "acc_test",
      email: "test@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.users).values({
      id: "usr_test",
      accountId: "acc_test",
      handle: "testuser",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.users).where(eq(schema.users.id, "usr_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("usr_test");
    expect(row.accountId).toBe("acc_test");
    expect(row.handle).toBe("testuser");
    expect(row.isDefault).toBe(true);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique handle constraint", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values({
      id: "acc_h1",
      email: "h1@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.accounts).values({
      id: "acc_h2",
      email: "h2@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.users).values({
      id: "usr_h1",
      accountId: "acc_h1",
      handle: "duphandle",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      db.insert(schema.users).values({
        id: "usr_h2",
        accountId: "acc_h2",
        handle: "duphandle",
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it("displayName and avatarUrl round-trip correctly", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values({
      id: "acc_display",
      email: "display@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.users).values({
      id: "usr_display",
      accountId: "acc_display",
      handle: "alice",
      displayName: "Alice Chen",
      avatarUrl: "https://example.com/avatar.jpg",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, "usr_display"));
    expect(row!.displayName).toBe("Alice Chen");
    expect(row!.avatarUrl).toBe("https://example.com/avatar.jpg");
  });

  it("displayName and avatarUrl default to null", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values({
      id: "acc_nodisplay",
      email: "nodisplay@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.users).values({
      id: "usr_nodisplay",
      accountId: "acc_nodisplay",
      handle: "nodisplay",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, "usr_nodisplay"));
    expect(row!.displayName).toBeNull();
    expect(row!.avatarUrl).toBeNull();
  });

  it("createdAt round-trips as Date via timestamp mode", async () => {
    const db = createTestDb();
    const ts = new Date("2030-01-15T08:00:00.000Z");
    await db.insert(schema.accounts).values({
      id: "acc_ts",
      email: "ts@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: ts,
      updatedAt: ts,
    });
    await db.insert(schema.users).values({
      id: "usr_ts",
      accountId: "acc_ts",
      handle: "tsuser",
      isDefault: true,
      createdAt: ts,
      updatedAt: ts,
    });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, "usr_ts"));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
  });
});

describe("passkeys schema", () => {
  it("inserts and retrieves a passkey linked to an account", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.accounts).values({
      id: "acc_pk",
      email: "pk@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passkeys).values({
      id: "pk_test",
      accountId: "acc_pk",
      credentialId: "cred-abc",
      publicKey: "base64-encoded-key",
      counter: 0,
      createdAt: now,
    });

    const rows = await db.select().from(schema.passkeys).where(eq(schema.passkeys.id, "pk_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("pk_test");
    expect(row.accountId).toBe("acc_pk");
    expect(row.credentialId).toBe("cred-abc");
    expect(row.counter).toBe(0);
    expect(row.transports).toBeNull();
  });

  it("optional transports field defaults to null", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values({
      id: "acc_notransport",
      email: "notransport@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passkeys).values({
      id: "pk_notransport",
      accountId: "acc_notransport",
      credentialId: "cred-notransport",
      publicKey: "key",
      counter: 0,
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.passkeys)
      .where(eq(schema.passkeys.id, "pk_notransport"));
    expect(row!.transports).toBeNull();
  });

  it("enforces unique credentialId constraint", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values({
      id: "acc_cred",
      email: "cred@example.com",
      passkeyUserId: crypto.randomUUID(),
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passkeys).values({
      id: "pk_c1",
      accountId: "acc_cred",
      credentialId: "dup-cred",
      publicKey: "key",
      counter: 0,
      createdAt: now,
    });
    await expect(
      db.insert(schema.passkeys).values({
        id: "pk_c2",
        accountId: "acc_cred",
        credentialId: "dup-cred",
        publicKey: "key",
        counter: 0,
        createdAt: now,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// service_accounts schema
// ---------------------------------------------------------------------------

describe("service_accounts schema", () => {
  it("inserts and retrieves a service account", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.serviceAccounts).values({
      serviceId: "pulse-api",
      allowedScopes: "graph:read,graph:write",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db
      .select()
      .from(schema.serviceAccounts)
      .where(eq(schema.serviceAccounts.serviceId, "pulse-api"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.serviceId).toBe("pulse-api");
    expect(row.allowedScopes).toBe("graph:read,graph:write");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces primary key uniqueness on service_id", async () => {
    const db = createTestDb();
    const now = new Date();
    const base = { allowedScopes: "graph:read", createdAt: now, updatedAt: now };
    await db.insert(schema.serviceAccounts).values({ serviceId: "svc-a", ...base });
    await expect(
      db.insert(schema.serviceAccounts).values({ serviceId: "svc-a", ...base }),
    ).rejects.toThrow();
  });

  it("timestamps round-trip as Date", async () => {
    const db = createTestDb();
    const ts = new Date("2030-01-15T08:00:00.000Z");
    await db.insert(schema.serviceAccounts).values({
      serviceId: "svc-ts",
      allowedScopes: "graph:read",
      createdAt: ts,
      updatedAt: ts,
    });
    const [row] = await db
      .select()
      .from(schema.serviceAccounts)
      .where(eq(schema.serviceAccounts.serviceId, "svc-ts"));
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
    expect(row!.updatedAt.getTime()).toBe(ts.getTime());
  });
});

// ---------------------------------------------------------------------------
// service_account_keys schema
// ---------------------------------------------------------------------------

describe("service_account_keys schema", () => {
  async function insertServiceAccount(db: ReturnType<typeof createTestDb>, serviceId: string) {
    const now = new Date();
    await db.insert(schema.serviceAccounts).values({
      serviceId,
      allowedScopes: "graph:read",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("inserts and retrieves a key row", async () => {
    const db = createTestDb();
    await insertServiceAccount(db, "pulse-api");
    const now = new Date();
    const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "abc", y: "def" });

    await db.insert(schema.serviceAccountKeys).values({
      keyId: "key-1",
      serviceId: "pulse-api",
      publicKeyJwk: jwk,
      registeredAt: now,
      expiresAt: null,
      revokedAt: null,
    });

    const rows = await db
      .select()
      .from(schema.serviceAccountKeys)
      .where(eq(schema.serviceAccountKeys.keyId, "key-1"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.keyId).toBe("key-1");
    expect(row.serviceId).toBe("pulse-api");
    expect(row.publicKeyJwk).toBe(jwk);
    expect(row.expiresAt).toBeNull();
    expect(row.revokedAt).toBeNull();
  });

  it("stores expiresAt and revokedAt as integers", async () => {
    const db = createTestDb();
    await insertServiceAccount(db, "svc-exp");
    const now = new Date();
    const expSecs = Math.floor(Date.now() / 1000) + 3600;
    const revSecs = Math.floor(Date.now() / 1000) - 60;

    await db.insert(schema.serviceAccountKeys).values({
      keyId: "key-exp",
      serviceId: "svc-exp",
      publicKeyJwk: "{}",
      registeredAt: now,
      expiresAt: expSecs,
      revokedAt: revSecs,
    });

    const [row] = await db
      .select()
      .from(schema.serviceAccountKeys)
      .where(eq(schema.serviceAccountKeys.keyId, "key-exp"));
    expect(row!.expiresAt).toBe(expSecs);
    expect(row!.revokedAt).toBe(revSecs);
  });

  it("enforces primary key uniqueness on key_id", async () => {
    const db = createTestDb();
    await insertServiceAccount(db, "svc-pk");
    const now = new Date();
    const base = { serviceId: "svc-pk", publicKeyJwk: "{}", registeredAt: now };
    await db.insert(schema.serviceAccountKeys).values({ keyId: "dup-key", ...base });
    await expect(
      db.insert(schema.serviceAccountKeys).values({ keyId: "dup-key", ...base }),
    ).rejects.toThrow();
  });
});
