import { chats, chatMembers, messages } from "@zap/db/schema";
import type { Chat, ChatMember, Message } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { and, desc, eq, lt } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  MAX_CIPHERTEXT_LENGTH,
  MAX_NONCE_LENGTH,
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
} from "../lib/limits";
import { metricMessageSent, metricMessagesListed } from "../metrics";

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class ChatNotFound extends Data.TaggedError("ChatNotFound")<{
  readonly id: string;
}> {}

export class NotChatMember extends Data.TaggedError("NotChatMember")<{
  readonly chatId: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Effect schemas
// ---------------------------------------------------------------------------

const CiphertextString = Schema.String.pipe(Schema.maxLength(MAX_CIPHERTEXT_LENGTH));
const NonceString = Schema.String.pipe(Schema.maxLength(MAX_NONCE_LENGTH));

const SendMessageSchema = Schema.Struct({
  ciphertext: CiphertextString,
  nonce: NonceString,
});

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export const sendMessage = (
  chatId: string,
  senderUserId: string,
  data: unknown,
): Effect.Effect<Message, ChatNotFound | NotChatMember | ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Verify chat exists.
    const chatRows = yield* Effect.tryPromise({
      try: (): Promise<Chat[]> =>
        db.select().from(chats).where(eq(chats.id, chatId)).limit(1) as Promise<Chat[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (chatRows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id: chatId }));
    }
    const chat = chatRows[0]!;

    // Verify sender is a member.
    yield* assertMember(chatId, senderUserId);

    const validated = yield* Schema.decodeUnknown(SendMessageSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const id = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();

    yield* Effect.tryPromise({
      try: () =>
        db.insert(messages).values({
          id,
          chatId,
          senderUserId,
          ciphertext: validated.ciphertext,
          nonce: validated.nonce,
          createdAt: now,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricMessageSent(chat.type as "dm" | "group" | "event", validated.ciphertext.length, "ok");

    const [msg] = yield* Effect.tryPromise({
      try: (): Promise<Message[]> =>
        db.select().from(messages).where(eq(messages.id, id)) as Promise<Message[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    return msg!;
  }).pipe(Effect.withSpan("zap.messages.send"));

export const listMessages = (
  chatId: string,
  userId: string,
  opts: { limit?: number; cursor?: string } = {},
): Effect.Effect<Message[], ChatNotFound | NotChatMember | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Verify chat exists.
    const chatRows = yield* Effect.tryPromise({
      try: (): Promise<Chat[]> =>
        db.select().from(chats).where(eq(chats.id, chatId)).limit(1) as Promise<Chat[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (chatRows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id: chatId }));
    }

    // Verify user is a member.
    yield* assertMember(chatId, userId);

    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT);

    // Cursor-based pagination: fetch messages older than the cursor.
    const conditions = [eq(messages.chatId, chatId)];
    if (opts.cursor) {
      // The cursor is a message ID. Look up its createdAt to paginate.
      const cursorRows = yield* Effect.tryPromise({
        try: (): Promise<Message[]> =>
          db.select().from(messages).where(eq(messages.id, opts.cursor!)).limit(1) as Promise<
            Message[]
          >,
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (cursorRows.length > 0) {
        conditions.push(lt(messages.createdAt, cursorRows[0]!.createdAt));
      }
    }

    const results = yield* Effect.tryPromise({
      try: (): Promise<Message[]> =>
        db
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.createdAt))
          .limit(limit) as Promise<Message[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricMessagesListed(results.length);
    return results;
  }).pipe(Effect.withSpan("zap.messages.list"));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const assertMember = (
  chatId: string,
  userId: string,
): Effect.Effect<void, NotChatMember | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db
          .select()
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
          .limit(1) as Promise<ChatMember[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new NotChatMember({ chatId }));
    }
  });
