import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";
import {
  buildSeedAccounts,
  buildSeedUsers,
  buildSeedConnections,
  buildSeedCloseFriends,
  buildSeedOrganisations,
  buildSeedOrgMembers,
  buildSeedServiceAccounts,
} from "../src/seed";

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
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id),
      addressee_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (requester_id, addressee_id)
    )
  `);
  sqlite.run(`
    CREATE TABLE close_friends (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES users(id),
      friend_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE (profile_id, friend_id)
    )
  `);
  sqlite.run(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL REFERENCES users(id),
      blocked_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE (blocker_id, blocked_id)
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
  sqlite.run(`
    CREATE TABLE organisations (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      avatar_url TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE organisation_members (
      id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisations(id),
      profile_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (organisation_id, profile_id)
    )
  `);
  return drizzle(sqlite, { schema });
}

// ---------------------------------------------------------------------------
// buildSeedAccounts
// ---------------------------------------------------------------------------

describe("buildSeedAccounts", () => {
  it("returns 21 accounts", () => {
    const accounts = buildSeedAccounts(new Date());
    expect(accounts).toHaveLength(21);
  });

  it("all IDs use acc_seed_ prefix", () => {
    for (const a of buildSeedAccounts(new Date())) {
      expect(a.id).toMatch(/^acc_seed_/);
    }
  });

  it("all emails are unique", () => {
    const emails = buildSeedAccounts(new Date()).map((a) => a.email);
    expect(new Set(emails).size).toBe(21);
  });

  it("includes acc_seed_me", () => {
    const ids = buildSeedAccounts(new Date()).map((a) => a.id);
    expect(ids).toContain("acc_seed_me");
  });

  it("includes acc_seed_multi for multi-account testing", () => {
    const ids = buildSeedAccounts(new Date()).map((a) => a.id);
    expect(ids).toContain("acc_seed_multi");
  });
});

// ---------------------------------------------------------------------------
// buildSeedUsers
// ---------------------------------------------------------------------------

describe("buildSeedUsers", () => {
  it("returns 23 profiles", () => {
    const users = buildSeedUsers(new Date());
    expect(users).toHaveLength(23);
  });

  it("all IDs use usr_seed_ prefix", () => {
    for (const u of buildSeedUsers(new Date())) {
      expect(u.id).toMatch(/^usr_seed_/);
    }
  });

  it("all handles are unique", () => {
    const handles = buildSeedUsers(new Date()).map((u) => u.handle);
    expect(new Set(handles).size).toBe(23);
  });

  it("every user has an accountId", () => {
    for (const u of buildSeedUsers(new Date())) {
      expect(u.accountId).toBeTruthy();
      expect(u.accountId).toMatch(/^acc_seed_/);
    }
  });

  it("every user has an isDefault field", () => {
    for (const u of buildSeedUsers(new Date())) {
      expect(typeof u.isDefault).toBe("boolean");
    }
  });

  it("includes usr_seed_me", () => {
    const ids = buildSeedUsers(new Date()).map((u) => u.id);
    expect(ids).toContain("usr_seed_me");
  });

  it("includes multi-account profiles", () => {
    const ids = buildSeedUsers(new Date()).map((u) => u.id);
    expect(ids).toContain("usr_seed_multi_main");
    expect(ids).toContain("usr_seed_multi_alt");
    expect(ids).toContain("usr_seed_multi_work");
  });

  it("multi-account profiles all reference acc_seed_multi", () => {
    const multiProfiles = buildSeedUsers(new Date()).filter((u) =>
      u.id.startsWith("usr_seed_multi_"),
    );
    expect(multiProfiles).toHaveLength(3);
    for (const u of multiProfiles) {
      expect(u.accountId).toBe("acc_seed_multi");
    }
  });

  it("only one multi-account profile is default", () => {
    const multiProfiles = buildSeedUsers(new Date()).filter((u) =>
      u.id.startsWith("usr_seed_multi_"),
    );
    const defaults = multiProfiles.filter((u) => u.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe("usr_seed_multi_main");
  });

  it("all accountIds reference valid seed accounts", () => {
    const accountIds = new Set(buildSeedAccounts(new Date()).map((a) => a.id));
    for (const u of buildSeedUsers(new Date())) {
      expect(accountIds.has(u.accountId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSeedConnections
// ---------------------------------------------------------------------------

describe("buildSeedConnections", () => {
  it("returns 28 connections", () => {
    const conns = buildSeedConnections(new Date());
    expect(conns).toHaveLength(28);
  });

  it("all IDs use conn_seed_ prefix", () => {
    for (const c of buildSeedConnections(new Date())) {
      expect(c.id).toMatch(/^conn_seed_/);
    }
  });

  it("me has 8 accepted direct connections", () => {
    const conns = buildSeedConnections(new Date()).filter(
      (c) =>
        c.status === "accepted" &&
        (c.requesterId === "usr_seed_me" || c.addresseeId === "usr_seed_me"),
    );
    expect(conns).toHaveLength(8);
  });

  it("me has 2 pending connections", () => {
    const conns = buildSeedConnections(new Date()).filter(
      (c) =>
        c.status === "pending" &&
        (c.requesterId === "usr_seed_me" || c.addresseeId === "usr_seed_me"),
    );
    expect(conns).toHaveLength(2);
  });

  it("all referenced user IDs exist in seed users", () => {
    const userIds = new Set(buildSeedUsers(new Date()).map((u) => u.id));
    for (const c of buildSeedConnections(new Date())) {
      expect(userIds.has(c.requesterId)).toBe(true);
      expect(userIds.has(c.addresseeId)).toBe(true);
    }
  });

  it("no duplicate pairs", () => {
    const pairs = new Set<string>();
    for (const c of buildSeedConnections(new Date())) {
      const pair = `${c.requesterId}:${c.addresseeId}`;
      expect(pairs.has(pair)).toBe(false);
      pairs.add(pair);
    }
  });

  it("includes multi-account cross-profile connections", () => {
    const conns = buildSeedConnections(new Date());
    const multiConns = conns.filter(
      (c) =>
        c.requesterId.startsWith("usr_seed_multi") || c.addresseeId.startsWith("usr_seed_multi"),
    );
    expect(multiConns.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// buildSeedCloseFriends
// ---------------------------------------------------------------------------

describe("buildSeedCloseFriends", () => {
  it("returns 3 close friends", () => {
    const cfs = buildSeedCloseFriends(new Date());
    expect(cfs).toHaveLength(3);
  });

  it("all are for usr_seed_me", () => {
    for (const cf of buildSeedCloseFriends(new Date())) {
      expect(cf.profileId).toBe("usr_seed_me");
    }
  });

  it("all IDs use clf_seed_ prefix", () => {
    for (const cf of buildSeedCloseFriends(new Date())) {
      expect(cf.id).toMatch(/^clf_seed_/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSeedOrganisations
// ---------------------------------------------------------------------------

describe("buildSeedOrganisations", () => {
  it("returns 2 organisations", () => {
    const orgs = buildSeedOrganisations(new Date());
    expect(orgs).toHaveLength(2);
  });

  it("all IDs use org_seed_ prefix", () => {
    for (const o of buildSeedOrganisations(new Date())) {
      expect(o.id).toMatch(/^org_seed_/);
    }
  });

  it("all handles are unique", () => {
    const handles = buildSeedOrganisations(new Date()).map((o) => o.handle);
    expect(new Set(handles).size).toBe(2);
  });

  it("all owner IDs reference valid seed users", () => {
    const userIds = new Set(buildSeedUsers(new Date()).map((u) => u.id));
    for (const o of buildSeedOrganisations(new Date())) {
      expect(userIds.has(o.ownerId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSeedOrgMembers
// ---------------------------------------------------------------------------

describe("buildSeedOrgMembers", () => {
  it("returns 6 members", () => {
    const members = buildSeedOrgMembers(new Date());
    expect(members).toHaveLength(6);
  });

  it("all IDs use orgm_seed_ prefix", () => {
    for (const m of buildSeedOrgMembers(new Date())) {
      expect(m.id).toMatch(/^orgm_seed_/);
    }
  });

  it("all profileIds reference valid seed users", () => {
    const userIds = new Set(buildSeedUsers(new Date()).map((u) => u.id));
    for (const m of buildSeedOrgMembers(new Date())) {
      expect(userIds.has(m.profileId)).toBe(true);
    }
  });

  it("all organisationIds reference valid seed organisations", () => {
    const orgIds = new Set(buildSeedOrganisations(new Date()).map((o) => o.id));
    for (const m of buildSeedOrgMembers(new Date())) {
      expect(orgIds.has(m.organisationId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSeedServiceAccounts
// ---------------------------------------------------------------------------

describe("buildSeedServiceAccounts", () => {
  it("returns exactly 1 service account", () => {
    const rows = buildSeedServiceAccounts(new Date());
    expect(rows).toHaveLength(1);
  });

  it("the service account ID is 'pulse-api'", () => {
    const rows = buildSeedServiceAccounts(new Date());
    expect(rows[0]!.serviceId).toBe("pulse-api");
  });

  it("allowedScopes is 'graph:read'", () => {
    const rows = buildSeedServiceAccounts(new Date());
    expect(rows[0]!.allowedScopes).toBe("graph:read");
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
    await db.insert(schema.closeFriends).values(buildSeedCloseFriends(now)).onConflictDoNothing();
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
    await db.insert(schema.closeFriends).values(buildSeedCloseFriends(now)).onConflictDoNothing();
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
    const closeFriends = await db.select().from(schema.closeFriends);
    const organisations = await db.select().from(schema.organisations);
    const orgMembers = await db.select().from(schema.organisationMembers);
    const serviceAccounts = await db.select().from(schema.serviceAccounts);

    expect(accounts).toHaveLength(21);
    expect(users).toHaveLength(23);
    expect(connections).toHaveLength(28);
    expect(closeFriends).toHaveLength(3);
    expect(organisations).toHaveLength(2);
    expect(orgMembers).toHaveLength(6);
    expect(serviceAccounts).toHaveLength(1);
  });
});
