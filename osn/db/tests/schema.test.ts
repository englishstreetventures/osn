import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";
import { applySchema } from "../src/testing";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Derived from the live Drizzle schema, never a hand-written mirror: the
  // uniqueness tests below must fail when a `.unique()` is dropped from
  // src/schema, which a local CREATE TABLE string can never detect.
  applySchema(sqlite);
  return drizzle(sqlite, { schema });
}

describe("accounts schema", () => {
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
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("users schema", () => {
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
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("passkeys schema", () => {
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
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

// ---------------------------------------------------------------------------
// service_accounts schema
// ---------------------------------------------------------------------------

describe("service_accounts schema", () => {
  it("enforces primary key uniqueness on service_id", async () => {
    const db = createTestDb();
    const now = new Date();
    const base = { allowedScopes: "graph:read", createdAt: now, updatedAt: now };
    await db.insert(schema.serviceAccounts).values({ serviceId: "svc-a", ...base });
    await expect(
      db.insert(schema.serviceAccounts).values({ serviceId: "svc-a", ...base }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
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

  it("enforces primary key uniqueness on key_id", async () => {
    const db = createTestDb();
    await insertServiceAccount(db, "svc-pk");
    const now = new Date();
    const base = { serviceId: "svc-pk", publicKeyJwk: "{}", registeredAt: now };
    await db.insert(schema.serviceAccountKeys).values({ keyId: "dup-key", ...base });
    await expect(
      db.insert(schema.serviceAccountKeys).values({ keyId: "dup-key", ...base }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
