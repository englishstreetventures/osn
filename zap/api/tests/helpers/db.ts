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
      class TEXT NOT NULL DEFAULT 'c2c',
      title TEXT,
      event_id TEXT,
      created_by_profile_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX chats_type_idx ON chats (type)`);
  sqlite.run(`CREATE INDEX chats_class_idx ON chats (class)`);
  sqlite.run(`CREATE INDEX chats_event_id_idx ON chats (event_id)`);
  sqlite.run(`CREATE INDEX chats_created_by_profile_id_idx ON chats (created_by_profile_id)`);
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
  sqlite.run(`CREATE INDEX chat_members_chat_idx ON chat_members (chat_id)`);
  sqlite.run(`CREATE INDEX chat_members_profile_idx ON chat_members (profile_id)`);
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
  sqlite.run(`CREATE INDEX messages_chat_idx ON messages (chat_id)`);
  sqlite.run(`CREATE INDEX messages_chat_created_idx ON messages (chat_id, created_at)`);
  sqlite.run(`CREATE INDEX messages_sender_idx ON messages (sender_profile_id)`);
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
  createdByProfileId?: string;
  /** Controllable timestamp for cursor-pagination tests. */
  createdAt?: Date;
}

export const seedChat = (input: SeedChatInput): Effect.Effect<Chat, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = input.createdAt ?? new Date();
    const row: Chat = {
      id,
      type: input.type,
      class: "c2c",
      title: input.title ?? null,
      eventId: input.eventId ?? null,
      createdByProfileId: input.createdByProfileId ?? "usr_alice",
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
  profileId: string,
  role: "admin" | "member" = "member",
): Effect.Effect<ChatMember, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    const row: ChatMember = { id, chatId, profileId, role, joinedAt: now };
    yield* Effect.promise(() => db.insert(chatMembers).values(row));
    return row;
  });

/**
 * Seed a message directly into the DB with a controllable timestamp.
 */
export const seedMessage = (
  chatId: string,
  senderProfileId: string,
  ciphertext: string,
  createdAt: Date,
): Effect.Effect<Message, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const row: Message = {
      id,
      chatId,
      senderProfileId,
      ciphertext,
      nonce: "test_nonce",
      body: null,
      createdAt,
      expiresAt: null,
    };
    yield* Effect.promise(() => db.insert(messages).values(row));
    return row;
  });

/**
 * Seed a c2b chat directly into the DB (class = 'c2b').
 */
export const seedC2bChat = (input: Omit<SeedChatInput, never>): Effect.Effect<Chat, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = input.createdAt ?? new Date();
    const row: Chat = {
      id,
      type: input.type,
      class: "c2b",
      title: input.title ?? null,
      eventId: input.eventId ?? null,
      createdByProfileId: input.createdByProfileId ?? "usr_alice",
      createdAt: now,
      updatedAt: now,
    };
    yield* Effect.promise(() => db.insert(chats).values(row));
    return row;
  });

/**
 * Seed a c2b (plaintext body) message directly into the DB.
 */
export const seedC2bMessage = (
  chatId: string,
  senderProfileId: string,
  body: string,
  createdAt?: Date,
): Effect.Effect<Message, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const row: Message = {
      id,
      chatId,
      senderProfileId,
      ciphertext: null,
      nonce: null,
      body,
      createdAt: createdAt ?? new Date(),
      expiresAt: null,
    };
    yield* Effect.promise(() => db.insert(messages).values(row));
    return row;
  });
