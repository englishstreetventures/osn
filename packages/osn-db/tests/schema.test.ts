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
  return drizzle(sqlite, { schema });
}

describe("users schema", () => {
  it("inserts and retrieves a row", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.users).values({
      id: "usr_test",
      email: "test@example.com",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.users).where(eq(schema.users.id, "usr_test"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("usr_test");
    expect(row.email).toBe("test@example.com");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique email constraint", async () => {
    const db = createTestDb();
    const now = new Date();
    await db
      .insert(schema.users)
      .values({ id: "usr_a", email: "dup@example.com", createdAt: now, updatedAt: now });
    await expect(
      db
        .insert(schema.users)
        .values({ id: "usr_b", email: "dup@example.com", createdAt: now, updatedAt: now }),
    ).rejects.toThrow();
  });

  it("displayName and avatarUrl round-trip correctly", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.users).values({
      id: "usr_display",
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
    await db
      .insert(schema.users)
      .values({ id: "usr_ts", email: "ts@example.com", createdAt: ts, updatedAt: ts });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, "usr_ts"));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
  });
});

describe("passkeys schema", () => {
  it("inserts and retrieves a passkey linked to a user", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db
      .insert(schema.users)
      .values({ id: "usr_pk", email: "pk@example.com", createdAt: now, updatedAt: now });
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
    await db
      .insert(schema.users)
      .values({ id: "usr_cred", email: "cred@example.com", createdAt: now, updatedAt: now });
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
