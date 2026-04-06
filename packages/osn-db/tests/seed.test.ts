import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../src/schema";
import { buildSeedUsers, buildSeedConnections, buildSeedCloseFriends } from "../src/seed";

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
      user_id TEXT NOT NULL REFERENCES users(id),
      friend_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, friend_id)
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
      public_key_jwk TEXT NOT NULL,
      allowed_scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

// ---------------------------------------------------------------------------
// buildSeedUsers
// ---------------------------------------------------------------------------

describe("buildSeedUsers", () => {
  it("returns 20 users", () => {
    const users = buildSeedUsers(new Date());
    expect(users).toHaveLength(20);
  });

  it("all IDs use usr_seed_ prefix", () => {
    for (const u of buildSeedUsers(new Date())) {
      expect(u.id).toMatch(/^usr_seed_/);
    }
  });

  it("all handles are unique", () => {
    const handles = buildSeedUsers(new Date()).map((u) => u.handle);
    expect(new Set(handles).size).toBe(20);
  });

  it("all emails are unique", () => {
    const emails = buildSeedUsers(new Date()).map((u) => u.email);
    expect(new Set(emails).size).toBe(20);
  });

  it("includes usr_seed_me", () => {
    const ids = buildSeedUsers(new Date()).map((u) => u.id);
    expect(ids).toContain("usr_seed_me");
  });
});

// ---------------------------------------------------------------------------
// buildSeedConnections
// ---------------------------------------------------------------------------

describe("buildSeedConnections", () => {
  it("returns 25 connections", () => {
    const conns = buildSeedConnections(new Date());
    expect(conns).toHaveLength(25);
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
      expect(cf.userId).toBe("usr_seed_me");
    }
  });

  it("all IDs use clf_seed_ prefix", () => {
    for (const cf of buildSeedCloseFriends(new Date())) {
      expect(cf.id).toMatch(/^clf_seed_/);
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

    await db.insert(schema.users).values(buildSeedUsers(now)).onConflictDoNothing();
    await db.insert(schema.connections).values(buildSeedConnections(now)).onConflictDoNothing();
    await db.insert(schema.closeFriends).values(buildSeedCloseFriends(now)).onConflictDoNothing();

    // Second run
    await db.insert(schema.users).values(buildSeedUsers(now)).onConflictDoNothing();
    await db.insert(schema.connections).values(buildSeedConnections(now)).onConflictDoNothing();
    await db.insert(schema.closeFriends).values(buildSeedCloseFriends(now)).onConflictDoNothing();

    const users = await db.select().from(schema.users);
    const connections = await db.select().from(schema.connections);
    const closeFriends = await db.select().from(schema.closeFriends);

    expect(users).toHaveLength(20);
    expect(connections).toHaveLength(25);
    expect(closeFriends).toHaveLength(3);
  });
});
