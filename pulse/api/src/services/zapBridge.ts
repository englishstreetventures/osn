/**
 * Bridge to @zap/api for event-chat provisioning.
 *
 * Currently a direct in-process import of Zap service functions.
 * When Zap moves to its own process, this file becomes an ARC-token
 * HTTP client — single-file change, no callers affected.
 */

import { Data, Effect } from "effect";
import { and, eq } from "drizzle-orm";
import { events } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { Db as ZapDb } from "@zap/db/service";
import { chats, chatMembers } from "@zap/db/schema";
import type { Chat, ChatMember } from "@zap/db/schema";

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class ZapBridgeError extends Data.TaggedError("ZapBridgeError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Provision an event chat in Zap and link it to the Pulse event.
 *
 * Idempotent: if the event already has a chatId, returns the existing chat.
 */
export const provisionEventChat = (
  eventId: string,
  creatorUserId: string,
  title: string,
): Effect.Effect<Chat, ZapBridgeError, Db | ZapDb> =>
  Effect.gen(function* () {
    const pulseDb = (yield* Db).db;
    const zapDb = (yield* ZapDb).db;

    // Check if event already has a chat.
    const eventRows = yield* Effect.tryPromise({
      try: () =>
        pulseDb
          .select({ chatId: events.chatId })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1) as Promise<{ chatId: string | null }[]>,
      catch: (cause) => new ZapBridgeError({ cause }),
    });
    if (eventRows[0]?.chatId) {
      const existingChats = yield* Effect.tryPromise({
        try: () =>
          zapDb.select().from(chats).where(eq(chats.id, eventRows[0]!.chatId!)).limit(1) as Promise<
            Chat[]
          >,
        catch: (cause) => new ZapBridgeError({ cause }),
      });
      if (existingChats[0]) return existingChats[0];
    }

    // Create the event chat in Zap DB.
    const chatId = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        zapDb.insert(chats).values({
          id: chatId,
          type: "event",
          title,
          eventId,
          createdByUserId: creatorUserId,
          createdAt: now,
          updatedAt: now,
        }),
      catch: (cause) => new ZapBridgeError({ cause }),
    });

    // Add creator as admin member.
    const memberId = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    yield* Effect.tryPromise({
      try: () =>
        zapDb.insert(chatMembers).values({
          id: memberId,
          chatId,
          userId: creatorUserId,
          role: "admin",
          joinedAt: now,
        }),
      catch: (cause) => new ZapBridgeError({ cause }),
    });

    // Link the chat to the Pulse event.
    yield* Effect.tryPromise({
      try: () => pulseDb.update(events).set({ chatId }).where(eq(events.id, eventId)),
      catch: (cause) => new ZapBridgeError({ cause }),
    });

    const chatRows = yield* Effect.tryPromise({
      try: () => zapDb.select().from(chats).where(eq(chats.id, chatId)).limit(1) as Promise<Chat[]>,
      catch: (cause) => new ZapBridgeError({ cause }),
    });
    return chatRows[0]!;
  }).pipe(Effect.withSpan("pulse.zap_bridge.provision_event_chat"));

/**
 * Add a user to an event chat (e.g. when they RSVP).
 */
export const addEventChatMember = (
  chatId: string,
  userId: string,
): Effect.Effect<void, ZapBridgeError, ZapDb> =>
  Effect.gen(function* () {
    const zapDb = (yield* ZapDb).db;

    // Check if already a member (idempotent).
    const existing = yield* Effect.tryPromise({
      try: () =>
        zapDb
          .select()
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId))) as Promise<
          ChatMember[]
        >,
      catch: (cause) => new ZapBridgeError({ cause }),
    });
    if (existing.length > 0) return;

    const memberId = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    yield* Effect.tryPromise({
      try: () =>
        zapDb.insert(chatMembers).values({
          id: memberId,
          chatId,
          userId,
          role: "member",
          joinedAt: new Date(),
        }),
      catch: (cause) => new ZapBridgeError({ cause }),
    });
  }).pipe(Effect.withSpan("pulse.zap_bridge.add_event_chat_member"));
