import { Database } from "bun:sqlite";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
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
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
  return drizzle(sqlite, { schema });
}

// ---------------------------------------------------------------------------
// chats schema
// ---------------------------------------------------------------------------

describe("chats schema", () => {
  it("inserts and retrieves a chat", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.chats).values({
      id: "chat_test1",
      type: "group",
      title: "Test Group",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_test1"));
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.id).toBe("chat_test1");
    expect(row.type).toBe("group");
    expect(row.title).toBe("Test Group");
    expect(row.eventId).toBeNull();
    expect(row.createdByProfileId).toBe("usr_alice");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("stores event chat with eventId", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.chats).values({
      id: "chat_evt1",
      type: "event",
      title: "Event Chat",
      eventId: "evt_abc123",
      createdByProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_evt1"));
    expect(row!.type).toBe("event");
    expect(row!.eventId).toBe("evt_abc123");
  });

  it("DM chats have null title and eventId", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.chats).values({
      id: "chat_dm1",
      type: "dm",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_dm1"));
    expect(row!.type).toBe("dm");
    expect(row!.title).toBeNull();
    expect(row!.eventId).toBeNull();
  });

  it("createdAt round-trips as Date via timestamp mode", async () => {
    const db = createTestDb();
    const ts = new Date("2030-01-15T08:00:00.000Z");
    await db.insert(schema.chats).values({
      id: "chat_ts",
      type: "group",
      createdByProfileId: "usr_alice",
      createdAt: ts,
      updatedAt: ts,
    });
    const [row] = await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_ts"));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
  });
});

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

  it("inserts and retrieves a member", async () => {
    const db = createTestDb();
    await seedChat(db);
    const now = new Date();
    await db.insert(schema.chatMembers).values({
      id: "cmem_1",
      chatId: "chat_mem_test",
      profileId: "usr_alice",
      role: "admin",
      joinedAt: now,
    });

    const rows = await db
      .select()
      .from(schema.chatMembers)
      .where(eq(schema.chatMembers.id, "cmem_1"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.chatId).toBe("chat_mem_test");
    expect(row.profileId).toBe("usr_alice");
    expect(row.role).toBe("admin");
    expect(row.joinedAt).toBeInstanceOf(Date);
  });

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
    ).rejects.toThrow();
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

// ---------------------------------------------------------------------------
// messages schema
// ---------------------------------------------------------------------------

describe("messages schema", () => {
  async function seedChat(db: ReturnType<typeof createTestDb>) {
    const now = new Date();
    await db.insert(schema.chats).values({
      id: "chat_msg_test",
      type: "group",
      title: "Message Test",
      createdByProfileId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("inserts and retrieves a message", async () => {
    const db = createTestDb();
    await seedChat(db);
    const now = new Date();
    await db.insert(schema.messages).values({
      id: "msg_1",
      chatId: "chat_msg_test",
      senderProfileId: "usr_alice",
      ciphertext: "dGVzdCBtZXNzYWdl",
      nonce: "YWJjZGVmMTIzNDU2",
      createdAt: now,
    });

    const rows = await db.select().from(schema.messages).where(eq(schema.messages.id, "msg_1"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.chatId).toBe("chat_msg_test");
    expect(row.senderProfileId).toBe("usr_alice");
    expect(row.ciphertext).toBe("dGVzdCBtZXNzYWdl");
    expect(row.nonce).toBe("YWJjZGVmMTIzNDU2");
    expect(row.expiresAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("stores optional expiresAt", async () => {
    const db = createTestDb();
    await seedChat(db);
    const now = new Date("2030-06-01T12:00:00.000Z");
    const expires = new Date("2030-06-02T12:00:00.000Z");
    await db.insert(schema.messages).values({
      id: "msg_exp",
      chatId: "chat_msg_test",
      senderProfileId: "usr_alice",
      ciphertext: "ZXhwaXJpbmc=",
      nonce: "bm9uY2UxMjM=",
      createdAt: now,
      expiresAt: expires,
    });
    const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, "msg_exp"));
    expect(row!.expiresAt).toBeInstanceOf(Date);
    expect(row!.expiresAt!.getTime()).toBe(expires.getTime());
  });

  it("createdAt round-trips as Date via timestamp mode", async () => {
    const db = createTestDb();
    await seedChat(db);
    const ts = new Date("2030-06-01T12:00:00.000Z");
    await db.insert(schema.messages).values({
      id: "msg_ts",
      chatId: "chat_msg_test",
      senderProfileId: "usr_alice",
      ciphertext: "dGVzdA==",
      nonce: "bm9uY2U=",
      createdAt: ts,
    });
    const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, "msg_ts"));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.createdAt.getTime()).toBe(ts.getTime());
  });
});
