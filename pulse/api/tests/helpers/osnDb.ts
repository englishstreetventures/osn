import { Database } from "bun:sqlite";

import * as osnSchema from "@osn/db/schema";
import { Db as OsnDb } from "@osn/db/service";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";

export interface OsnTestContext {
  layer: Layer.Layer<OsnDb>;
  db: BunSQLiteDatabase<typeof osnSchema>;
}

/**
 * Creates a self-contained in-memory OSN DB layer for tests that need to
 * cover the RSVP visibility filter (which reads the social graph and user
 * display rows from @osn/db).
 *
 * Returns both the Effect layer (for providing to the service under test)
 * and the underlying drizzle client (for seeding fixtures directly).
 *
 * Only the tables the graph-bridge helper touches are created — users,
 * connections, close_friends, blocks. Missing tables would break the
 * Effect pipeline at runtime, so add any new ones the bridge starts using.
 */
export function createOsnTestContext(): OsnTestContext {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
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
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      addressee_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (requester_id, addressee_id)
    )
  `);
  sqlite.run(`
    CREATE TABLE close_friends (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (profile_id, friend_id)
    )
  `);
  sqlite.run(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (blocker_id, blocked_id)
    )
  `);
  const db = drizzle(sqlite, { schema: osnSchema });
  return { layer: Layer.succeed(OsnDb, { db }), db };
}

/** Inserts an account + user row into the OSN test DB. */
export async function seedOsnUser(
  ctx: OsnTestContext,
  user: { id: string; handle?: string; email?: string; displayName?: string | null },
): Promise<void> {
  const now = new Date();
  const accountId = user.id.replace(/^usr_/, "acc_");
  // Create an account for this user (idempotent — ignore conflicts from
  // multi-profile scenarios where two users share one account).
  await ctx.db
    .insert(osnSchema.accounts)
    .values({
      id: accountId,
      email: user.email ?? `${user.id}@example.com`,
      maxProfiles: 5,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await ctx.db.insert(osnSchema.users).values({
    id: user.id,
    accountId,
    handle: user.handle ?? user.id.replace(/^usr_/, ""),
    displayName: user.displayName ?? null,
    avatarUrl: null,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  });
}

/** Inserts an accepted connection between two users (both directions). */
export async function seedConnection(
  ctx: OsnTestContext,
  requesterId: string,
  addresseeId: string,
): Promise<void> {
  const now = new Date();
  await ctx.db.insert(osnSchema.connections).values({
    id: "conn_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    requesterId,
    addresseeId,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  });
}

/** Marks `friendId` as a close friend of `profileId` (directional). */
export async function seedCloseFriend(
  ctx: OsnTestContext,
  profileId: string,
  friendId: string,
): Promise<void> {
  const now = new Date();
  await ctx.db.insert(osnSchema.closeFriends).values({
    id: "clf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    profileId,
    friendId,
    createdAt: now,
  });
}
