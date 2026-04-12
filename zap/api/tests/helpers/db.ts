import { Database } from "bun:sqlite";

import * as schema from "@zap/db/schema";
import {
  chats,
  chatMembers,
  messages,
  type Chat,
  type ChatMember,
  type Message,
} from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";

export function createTestLayer() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      event_id TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX chats_type_idx ON chats (type)`);
  sqlite.run(`CREATE INDEX chats_event_id_idx ON chats (event_id)`);
  sqlite.run(`CREATE INDEX chats_created_by_user_id_idx ON chats (created_by_user_id)`);
  sqlite.run(`
    CREATE TABLE chat_members (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      UNIQUE (chat_id, user_id)
    )
  `);
  sqlite.run(`CREATE INDEX chat_members_chat_idx ON chat_members (chat_id)`);
  sqlite.run(`CREATE INDEX chat_members_user_idx ON chat_members (user_id)`);
  sqlite.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      sender_user_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
  sqlite.run(`CREATE INDEX messages_chat_idx ON messages (chat_id)`);
  sqlite.run(`CREATE INDEX messages_chat_created_idx ON messages (chat_id, created_at)`);
  sqlite.run(`CREATE INDEX messages_sender_idx ON messages (sender_user_id)`);
  const db = drizzle(sqlite, { schema });
  return Layer.succeed(Db, { db });
}

/**
 * Seed a chat directly into the DB, bypassing service-layer validation.
 */
export interface SeedChatInput {
  type: "dm" | "group" | "event";
  title?: string;
  eventId?: string;
  createdByUserId?: string;
}

export const seedChat = (input: SeedChatInput): Effect.Effect<Chat, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    const row: Chat = {
      id,
      type: input.type,
      title: input.title ?? null,
      eventId: input.eventId ?? null,
      createdByUserId: input.createdByUserId ?? "usr_alice",
      createdAt: now,
      updatedAt: now,
    };
    yield* Effect.promise(() => db.insert(chats).values(row));
    return row;
  });

/**
 * Seed a chat member directly into the DB.
 */
export const seedMember = (
  chatId: string,
  userId: string,
  role: "admin" | "member" = "member",
): Effect.Effect<ChatMember, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    const row: ChatMember = { id, chatId, userId, role, joinedAt: now };
    yield* Effect.promise(() => db.insert(chatMembers).values(row));
    return row;
  });

/**
 * Seed a message directly into the DB with a controllable timestamp.
 */
export const seedMessage = (
  chatId: string,
  senderUserId: string,
  ciphertext: string,
  createdAt: Date,
): Effect.Effect<Message, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const row: Message = {
      id,
      chatId,
      senderUserId,
      ciphertext,
      nonce: "test_nonce",
      createdAt,
      expiresAt: null,
    };
    yield* Effect.promise(() => db.insert(messages).values(row));
    return row;
  });
