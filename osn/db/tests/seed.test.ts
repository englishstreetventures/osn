import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";
import {
  buildSeedAccounts,
  buildSeedUsers,
  buildSeedConnections,
  buildSeedOrganisations,
  buildSeedOrgMembers,
  buildSeedServiceAccounts,
  seedProfileRows,
} from "../src/seed";
import { applySchema } from "../src/testing";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Derived from the live Drizzle schema, never a hand-written mirror: a local
  // CREATE TABLE drifts silently, and a seed test that builds its own tables
  // fails on any column change it has no opinion about. `applySchema` also
  // turns foreign keys ON, so the insert order below is checked against the
  // constraints production actually enforces.
  applySchema(sqlite);
  return drizzle({ client: sqlite });
}

describe("buildSeedUsers", () => {
  it("only one multi-account profile is default", () => {
    const multiProfiles = buildSeedUsers(new Date()).filter((u) =>
      u.id.startsWith("usr_seed_multi_"),
    );
    const defaults = multiProfiles.filter((u) => u.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe("usr_seed_multi_main");
  });
});

describe("seedProfileRows", () => {
  it("leaves a seeded default plain when its account already has another default", async () => {
    // An account holds one default profile, and its index refuses a second.
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.accounts).values(buildSeedAccounts(now)).onConflictDoNothing();
    await db.insert(schema.users).values({
      id: "usr_seed_multi_chosen",
      accountId: "acc_seed_multi",
      handle: "multi_chosen",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.users).values(seedProfileRows(now)).onConflictDoNothing();

    const rows = await db
      .select({ id: schema.users.id, isDefault: schema.users.isDefault })
      .from(schema.users);
    const multi = Object.fromEntries(
      rows.filter((r) => r.id.startsWith("usr_seed_multi_")).map((r) => [r.id, r.isDefault]),
    );
    expect(multi).toEqual({
      usr_seed_multi_chosen: true,
      usr_seed_multi_main: false,
      usr_seed_multi_alt: false,
      usr_seed_multi_work: false,
    });
  });
});

describe("buildSeedConnections", () => {
  it("no duplicate pairs", () => {
    const pairs = new Set<string>();
    for (const c of buildSeedConnections(new Date())) {
      const pair = `${c.requesterId}:${c.addresseeId}`;
      expect(pairs.has(pair)).toBe(false);
      pairs.add(pair);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("seed idempotency", () => {
  it("inserting all seed data twice does not duplicate rows", async () => {
    const db = createTestDb();
    const now = new Date();

    await db.insert(schema.accounts).values(buildSeedAccounts(now)).onConflictDoNothing();
    await db.insert(schema.users).values(buildSeedUsers(now)).onConflictDoNothing();
    await db.insert(schema.connections).values(buildSeedConnections(now)).onConflictDoNothing();
    await db.insert(schema.organisations).values(buildSeedOrganisations(now)).onConflictDoNothing();
    await db
      .insert(schema.organisationMembers)
      .values(buildSeedOrgMembers(now))
      .onConflictDoNothing();
    await db
      .insert(schema.serviceAccounts)
      .values(buildSeedServiceAccounts(now))
      .onConflictDoNothing();

    // Second run — onConflictDoNothing must prevent duplicates.
    await db.insert(schema.accounts).values(buildSeedAccounts(now)).onConflictDoNothing();
    await db.insert(schema.users).values(buildSeedUsers(now)).onConflictDoNothing();
    await db.insert(schema.connections).values(buildSeedConnections(now)).onConflictDoNothing();
    await db.insert(schema.organisations).values(buildSeedOrganisations(now)).onConflictDoNothing();
    await db
      .insert(schema.organisationMembers)
      .values(buildSeedOrgMembers(now))
      .onConflictDoNothing();
    await db
      .insert(schema.serviceAccounts)
      .values(buildSeedServiceAccounts(now))
      .onConflictDoNothing();

    const accounts = await db.select().from(schema.accounts);
    const users = await db.select().from(schema.users);
    const connections = await db.select().from(schema.connections);
    const organisations = await db.select().from(schema.organisations);
    const orgMembers = await db.select().from(schema.organisationMembers);
    const serviceAccounts = await db.select().from(schema.serviceAccounts);

    expect(accounts).toHaveLength(21);
    expect(users).toHaveLength(23);
    expect(connections).toHaveLength(28);
    expect(organisations).toHaveLength(2);
    expect(orgMembers).toHaveLength(6);
    expect(serviceAccounts).toHaveLength(1);
  });
});
