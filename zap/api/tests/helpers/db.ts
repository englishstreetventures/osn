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
import { applySchema } from "@zap/db/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";

/**
 * A fresh in-memory database with the live `@zap/db` schema applied.
 *
 * `applySchema` emits the DDL from the Drizzle schema itself, so this cannot
 * drift from what `zap/db` declares or what the migrations build. It replaced a
 * hand-written `CREATE TABLE`/`CREATE INDEX` block that was a third, unpinned
 * copy of the schema: dropping `chats_class_idx` meant editing it by hand, and
 * a stale index — or a missing `UNIQUE (chat_id, profile_id)` — left every
 * constraint test in this package asserting the DDL its author typed rather
 * than the shape production enforces. `wiki/conventions/testing-patterns.md`
 * names that anti-pattern; `osn/api` and `pulse/api` already use this seam.
 */
export function createTestLayer() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
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
