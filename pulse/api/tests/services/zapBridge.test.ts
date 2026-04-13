import { Database } from "bun:sqlite";

import { it } from "@effect/vitest";
import * as pulseSchema from "@pulse/db/schema";
import { events } from "@pulse/db/schema";
import { Db as PulseDb } from "@pulse/db/service";
import * as zapSchema from "@zap/db/schema";
import { chatMembers } from "@zap/db/schema";
import { Db as ZapDb } from "@zap/db/service";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { provisionEventChat, addEventChatMember } from "../../src/services/zapBridge";

function createDualTestLayer() {
  const pulseSqlite = new Database(":memory:");
  pulseSqlite.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      venue TEXT,
      category TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      status TEXT NOT NULL DEFAULT 'upcoming',
      image_url TEXT,
      latitude REAL,
      longitude REAL,
      visibility TEXT NOT NULL DEFAULT 'public',
      guest_list_visibility TEXT NOT NULL DEFAULT 'public',
      join_policy TEXT NOT NULL DEFAULT 'open',
      allow_interested INTEGER NOT NULL DEFAULT 1,
      comms_channels TEXT NOT NULL DEFAULT '["email"]',
      chat_id TEXT,
      created_by_profile_id TEXT NOT NULL,
      created_by_name TEXT,
      created_by_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const pulseDb = drizzle(pulseSqlite, { schema: pulseSchema });

  const zapSqlite = new Database(":memory:");
  zapSqlite.run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, event_id TEXT,
      created_by_profile_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
  zapSqlite.run(`
    CREATE TABLE chat_members (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
      profile_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL, UNIQUE (chat_id, profile_id)
    )
  `);
  zapSqlite.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
      sender_profile_id TEXT NOT NULL, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER
    )
  `);
  const zapDb = drizzle(zapSqlite, { schema: zapSchema });

  const layer = Layer.mergeAll(
    Layer.succeed(PulseDb, { db: pulseDb }),
    Layer.succeed(ZapDb, { db: zapDb }),
  );
  return { layer, pulseDb, zapDb };
}

const seedEvent = (
  pulseDb: ReturnType<typeof createDualTestLayer>["pulseDb"],
  id: string,
  createdByProfileId: string,
): Effect.Effect<void> => {
  const now = new Date();
  return Effect.promise(() =>
    pulseDb.insert(events).values({
      id,
      title: "Test Event",
      startTime: new Date("2030-06-01T10:00:00.000Z"),
      createdByProfileId,
      createdAt: now,
      updatedAt: now,
    }),
  ).pipe(Effect.asVoid);
};

describe("zapBridge", () => {
  describe("provisionEventChat", () => {
    it.effect("provisions a new event chat and links it to the event", () => {
      const { layer, pulseDb, zapDb } = createDualTestLayer();
      return Effect.gen(function* () {
        yield* seedEvent(pulseDb, "evt_test1", "usr_alice");

        const chat = yield* provisionEventChat("evt_test1", "usr_alice", "Event Chat");
        expect(chat.id).toMatch(/^chat_/);
        expect(chat.type).toBe("event");
        expect(chat.title).toBe("Event Chat");
        expect(chat.eventId).toBe("evt_test1");

        // Verify the event now has a chatId.
        const eventRows = yield* Effect.promise(() =>
          pulseDb.select({ chatId: events.chatId }).from(events).where(eq(events.id, "evt_test1")),
        );
        expect(eventRows[0]!.chatId).toBe(chat.id);

        // Verify creator was added as admin.
        const members = yield* Effect.promise(() =>
          zapDb.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id)),
        );
        expect(members).toHaveLength(1);
        expect(members[0]!.profileId).toBe("usr_alice");
        expect(members[0]!.role).toBe("admin");
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns existing chat on idempotent re-provision", () => {
      const { layer, pulseDb } = createDualTestLayer();
      return Effect.gen(function* () {
        yield* seedEvent(pulseDb, "evt_idem", "usr_alice");

        const chat1 = yield* provisionEventChat("evt_idem", "usr_alice", "Event Chat");
        const chat2 = yield* provisionEventChat("evt_idem", "usr_alice", "Event Chat");
        expect(chat2.id).toBe(chat1.id);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("addEventChatMember", () => {
    it.effect("adds a new member to the event chat", () => {
      const { layer, pulseDb, zapDb } = createDualTestLayer();
      return Effect.gen(function* () {
        yield* seedEvent(pulseDb, "evt_mem", "usr_alice");
        const chat = yield* provisionEventChat("evt_mem", "usr_alice", "Event Chat");
        yield* addEventChatMember(chat.id, "usr_bob");

        const members = yield* Effect.promise(() =>
          zapDb.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id)),
        );
        expect(members).toHaveLength(2);
        const profileIds = members.map((m) => m.profileId).toSorted();
        expect(profileIds).toEqual(["usr_alice", "usr_bob"]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("is idempotent for existing members", () => {
      const { layer, pulseDb, zapDb } = createDualTestLayer();
      return Effect.gen(function* () {
        yield* seedEvent(pulseDb, "evt_idem2", "usr_alice");
        const chat = yield* provisionEventChat("evt_idem2", "usr_alice", "Event Chat");
        yield* addEventChatMember(chat.id, "usr_bob");
        yield* addEventChatMember(chat.id, "usr_bob");

        const members = yield* Effect.promise(() =>
          zapDb.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id)),
        );
        expect(members).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    });
  });
});
