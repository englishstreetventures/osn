import { Database } from "bun:sqlite";

import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";

export function createTestLayer() {
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
  sqlite.run(`CREATE INDEX connections_requester_idx ON connections (requester_id)`);
  sqlite.run(`CREATE INDEX connections_addressee_idx ON connections (addressee_id)`);
  sqlite.run(`
    CREATE TABLE close_friends (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      friend_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, friend_id)
    )
  `);
  sqlite.run(`CREATE INDEX close_friends_user_idx ON close_friends (user_id)`);
  sqlite.run(`CREATE INDEX close_friends_friend_idx ON close_friends (friend_id)`);
  sqlite.run(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL REFERENCES users(id),
      blocked_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE (blocker_id, blocked_id)
    )
  `);
  sqlite.run(`CREATE INDEX blocks_blocker_idx ON blocks (blocker_id)`);
  sqlite.run(`CREATE INDEX blocks_blocked_idx ON blocks (blocked_id)`);
  sqlite.run(`
    CREATE TABLE service_accounts (
      service_id TEXT PRIMARY KEY,
      public_key_jwk TEXT NOT NULL,
      allowed_scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
  sqlite.run(`CREATE INDEX organisations_owner_idx ON organisations (owner_id)`);
  sqlite.run(`
    CREATE TABLE organisation_members (
      id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (organisation_id, user_id)
    )
  `);
  sqlite.run(`CREATE INDEX org_members_org_idx ON organisation_members (organisation_id)`);
  sqlite.run(`CREATE INDEX org_members_user_idx ON organisation_members (user_id)`);
  const db = drizzle(sqlite, { schema });
  return Layer.succeed(Db, { db });
}
