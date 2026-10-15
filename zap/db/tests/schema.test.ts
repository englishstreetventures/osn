import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";

// ---------------------------------------------------------------------------
// Migration chain tests — apply real .sql files sequentially (like wrangler d1
// migrations apply does) to catch SELECT-from-old-table column mismatches that
// schema-from-scratch tests cannot detect.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(__dirname, "../drizzle");

function applyMigration(sqlite: Database, filename: string) {
  const sql = readFileSync(join(DRIZZLE_DIR, filename), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) sqlite.run(trimmed);
  }
}

describe("migration chain", () => {
  it("applies 0000 then 0001 sequentially without error", () => {
    const sqlite = new Database(":memory:");
    expect(() => applyMigration(sqlite, "0000_dry_tempest.sql")).not.toThrow();
    expect(() => applyMigration(sqlite, "0001_solid_mimic.sql")).not.toThrow();

    // messages must have nullable body column after 0001
    const msgCols = sqlite.query("PRAGMA table_info(messages)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const bodyCol = msgCols.find((c) => c.name === "body");
    expect(bodyCol, "messages.body column must exist after 0001").toBeDefined();
    expect(bodyCol!.notnull, "messages.body must be nullable").toBe(0);

    // chats must gain class column after 0001
    const chatCols = sqlite.query("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
    expect(
      chatCols.some((c) => c.name === "class"),
      "chats.class column must exist after 0001",
    ).toBe(true);
  });

  it("pre-existing messages (no body) survive the 0001 migration", () => {
    const sqlite = new Database(":memory:");
    applyMigration(sqlite, "0000_dry_tempest.sql");

    // Insert a row that matches the pre-0001 schema (no body column)
    sqlite.run(`
      INSERT INTO chats (id, type, created_by_profile_id, created_at, updated_at)
      VALUES ('chat_legacy', 'c2c', 'usr_alice', 1000, 1000)
    `);
    sqlite.run(`
      INSERT INTO messages (id, chat_id, sender_profile_id, ciphertext, nonce, created_at)
      VALUES ('msg_legacy', 'chat_legacy', 'usr_alice', 'abc', 'xyz', 1000)
    `);

    applyMigration(sqlite, "0001_solid_mimic.sql");

    const rows = sqlite
      .query("SELECT id, body FROM messages WHERE id = 'msg_legacy'")
      .all() as Array<{ id: string; body: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBeNull();
  });
});

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      class TEXT NOT NULL DEFAULT 'c2c',
      title TEXT,
      event_id TEXT,
      created_by_profile_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE chat_members (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      profile_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      UNIQUE (chat_id, profile_id)
    )
  `);
  sqlite.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      sender_profile_id TEXT NOT NULL,
      ciphertext TEXT,
      nonce TEXT,
      body TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
  return drizzle(sqlite, { schema });
}

// ---------------------------------------------------------------------------
// chat_members schema
// ---------------------------------------------------------------------------

describe("chat_members schema", () => {
  async function seedChat(db: ReturnType<typeof createTestDb>) {
    const now = new Date();
    await db.insert(schema.chats).values({
      id: "chat_mem_test",
      type: "group",
      title: "Members Test",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("defaults role to member", async () => {
    const db = createTestDb();
    await seedChat(db);
    await db.insert(schema.chatMembers).values({
      id: "cmem_default",
      chatId: "chat_mem_test",
      profileId: "usr_bob",
      joinedAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(schema.chatMembers)
      .where(eq(schema.chatMembers.id, "cmem_default"));
    expect(row!.role).toBe("member");
  });

  it("enforces unique (chatId, profileId) constraint", async () => {
    const db = createTestDb();
    await seedChat(db);
    const now = new Date();
    await db.insert(schema.chatMembers).values({
      id: "cmem_dup1",
      chatId: "chat_mem_test",
      profileId: "usr_alice",
      joinedAt: now,
    });
    await expect(
      db.insert(schema.chatMembers).values({
        id: "cmem_dup2",
        chatId: "chat_mem_test",
        profileId: "usr_alice",
        joinedAt: now,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("allows same user in different chats", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.chats).values([
      {
        id: "chat_a",
        type: "group",
        createdByProfileId: "usr_x",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "chat_b",
        type: "group",
        createdByProfileId: "usr_x",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.chatMembers).values([
      { id: "cmem_a", chatId: "chat_a", profileId: "usr_alice", joinedAt: now },
      { id: "cmem_b", chatId: "chat_b", profileId: "usr_alice", joinedAt: now },
    ]);
    const rows = await db.select().from(schema.chatMembers);
    expect(rows).toHaveLength(2);
  });
});
