import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE service_accounts (
      service_id TEXT PRIMARY KEY,
      public_key_jwk TEXT NOT NULL,
      allowed_scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("users schema", () => {
  it("inserts and retrieves a row", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.users).values({
      id: "usr_test",
      handle: "testuser",
      email: "test@example.com",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.users).where(eq(schema.users.id, "usr_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("usr_test");
    expect(row.handle).toBe("testuser");
    expect(row.email).toBe("test@example.com");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique email constraint", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.users).values({
      id: "usr_a",
      handle: "usera",
      email: "dup@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      db.insert(schema.users).values({
        id: "usr_b",
        handle: "userb",
        email: "dup@example.com",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it("enforces unique handle constraint", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.users).values({
      id: "usr_h1",
      handle: "duphandle",
      email: "h1@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      db.insert(schema.users).values({
        id: "usr_h2",
        handle: "duphandle",
        email: "h2@example.com",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it("displayName and avatarUrl round-trip correctly", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.users).values({
      id: "usr_display",
      handle: "alice",
      email: "display@example.com",
      displayName: "Alice Chen",
      avatarUrl: "https://example.com/avatar.jpg",
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
    await db.insert(schema.users).values({
      id: "usr_nodisplay",
      handle: "nodisplay",
      email: "nodisplay@example.com",
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
    await db.insert(schema.users).values({
      id: "usr_ts",
      handle: "tsuser",
      email: "ts@example.com",
      createdAt: ts,
      updatedAt: ts,
    });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, "usr_ts"));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
  });
});

describe("passkeys schema", () => {
  it("inserts and retrieves a passkey linked to a user", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.users).values({
      id: "usr_pk",
      handle: "pkuser",
      email: "pk@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passkeys).values({
      id: "pk_test",
      userId: "usr_pk",
      credentialId: "cred-abc",
      publicKey: "base64-encoded-key",
      counter: 0,
      createdAt: now,
    });

    const rows = await db.select().from(schema.passkeys).where(eq(schema.passkeys.id, "pk_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("pk_test");
    expect(row.userId).toBe("usr_pk");
    expect(row.credentialId).toBe("cred-abc");
    expect(row.counter).toBe(0);
    expect(row.transports).toBeNull();
  });

  it("optional transports field defaults to null", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.users).values({
      id: "usr_notransport",
      handle: "notransport",
      email: "notransport@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passkeys).values({
      id: "pk_notransport",
      userId: "usr_notransport",
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
    await db.insert(schema.users).values({
      id: "usr_cred",
      handle: "creduser",
      email: "cred@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.passkeys).values({
      id: "pk_c1",
      userId: "usr_cred",
      credentialId: "dup-cred",
      publicKey: "key",
      counter: 0,
      createdAt: now,
    });
    await expect(
      db.insert(schema.passkeys).values({
        id: "pk_c2",
        userId: "usr_cred",
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
    const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "abc", y: "def" });
    await db.insert(schema.serviceAccounts).values({
      serviceId: "pulse-api",
      publicKeyJwk: jwk,
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
    expect(row.publicKeyJwk).toBe(jwk);
    expect(row.allowedScopes).toBe("graph:read,graph:write");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces primary key uniqueness on service_id", async () => {
    const db = createTestDb();
    const now = new Date();
    const base = {
      publicKeyJwk: "{}",
      allowedScopes: "graph:read",
      createdAt: now,
      updatedAt: now,
    };
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
      publicKeyJwk: "{}",
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
