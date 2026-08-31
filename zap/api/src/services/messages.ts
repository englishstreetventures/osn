import { commitBatch } from "@shared/db-utils";
import { chats, chatMembers, messages } from "@zap/db/schema";
import type { Chat, Message } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  MAX_CIPHERTEXT_LENGTH,
  MAX_NONCE_LENGTH,
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_BODY_LENGTH,
} from "../lib/limits";
import { storedNow } from "../lib/storedNow";
import { metricMessageSent, metricMessagesListed } from "../metrics";
import { NotC2bChat, NotC2cChat } from "./chats";

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

const SendC2bMessageSchema = Schema.Struct({
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_BODY_LENGTH)),
});

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export const sendMessage = (
  chatId: string,
  senderProfileId: string,
  data: unknown,
): Effect.Effect<
  Message,
  ChatNotFound | NotChatMember | NotC2cChat | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Verify chat exists and sender is a member in one LEFT JOIN, in place of
    // the separate SELECT + assertMember round trips this used to make.
    const rows = yield* Effect.tryPromise({
      try: (): Promise<{ chat: Chat; memberId: string | null }[]> =>
        db
          .select({ chat: chats, memberId: chatMembers.id })
          .from(chats)
          .leftJoin(
            chatMembers,
            and(eq(chatMembers.chatId, chats.id), eq(chatMembers.profileId, senderProfileId)),
          )
          .where(eq(chats.id, chatId))
          .limit(1) as Promise<{ chat: Chat; memberId: string | null }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id: chatId }));
    }
    const { chat, memberId } = rows[0]!;
    if (memberId === null) {
      return yield* Effect.fail(new NotChatMember({ chatId }));
    }

    // Assert this is a c2c chat — the mirror of `sendC2bMessage`'s check.
    // Without it a member of a c2b chat could write ciphertext into it through
    // this route, producing a row that escapes both the DSAR export and every
    // moderation path, in the one chat class that promises both.
    //
    // AFTER the membership check, unlike `sendC2bMessage`, and the difference
    // is the audience. That one is ARC-gated and only cire calls it. This one
    // is public, so a class check ahead of membership would answer 409 "not a
    // c2c chat" to any authenticated stranger holding a chat id — telling them
    // which ids are commercial. Members already know.
    if (chat.class !== "c2c") {
      return yield* Effect.fail(new NotC2cChat({ chatId }));
    }

    const validated = yield* Schema.decodeUnknown(SendMessageSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const id = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = storedNow();

    const row: Message = {
      id,
      chatId,
      senderProfileId,
      ciphertext: validated.ciphertext,
      nonce: validated.nonce,
      body: null,
      createdAt: now,
      expiresAt: null,
    };

    yield* Effect.tryPromise({
      try: () => db.insert(messages).values(row),
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricMessageSent(chat.type as "dm" | "group" | "event", validated.ciphertext.length, "ok");

    // Returned from the values just written — see `sendC2bMessage`.
    return row;
  }).pipe(Effect.withSpan("zap.messages.send"));

export const listMessages = (
  chatId: string,
  profileId: string,
  opts: { limit?: number; cursor?: string } = {},
): Effect.Effect<
  Message[],
  ChatNotFound | NotChatMember | NotC2cChat | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Verify chat exists and user is a member in one LEFT JOIN, in place of
    // the separate SELECT + assertMember round trips this used to make.
    const rows = yield* Effect.tryPromise({
      try: (): Promise<{ chat: Chat; memberId: string | null }[]> =>
        db
          .select({ chat: chats, memberId: chatMembers.id })
          .from(chats)
          .leftJoin(
            chatMembers,
            and(eq(chatMembers.chatId, chats.id), eq(chatMembers.profileId, profileId)),
          )
          .where(eq(chats.id, chatId))
          .limit(1) as Promise<{ chat: Chat; memberId: string | null }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id: chatId }));
    }
    const { chat, memberId } = rows[0]!;
    if (memberId === null) {
      return yield* Effect.fail(new NotChatMember({ chatId }));
    }

    // The read half of the same rule the write path enforces. Without it the
    // public route serves a c2b chat's plaintext `body` column to any member,
    // going round the ARC-gated, `chat:c2b`-scoped reader that is supposed to
    // be the only way to it — and hands a client written to decrypt messages
    // rows whose `ciphertext` and `nonce` are both null.
    //
    // After the membership check, for the reason `sendMessage` gives.
    if (chat.class !== "c2c") {
      return yield* Effect.fail(new NotC2cChat({ chatId }));
    }

    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT);

    // Cursor-based pagination: fetch messages older than the cursor.
    const conditions = [eq(messages.chatId, chatId)];
    if (opts.cursor) {
      // Z6: the cursor is a message ID. Scope the lookup to THIS chat so a
      // cursor from another chat can't be used to probe message timing, and
      // reject an unknown/foreign cursor with a validation error instead of
      // silently falling back to page 1 (which masks a malformed client or a
      // cross-chat probe).
      const cursorRows = yield* Effect.tryPromise({
        try: (): Promise<Message[]> =>
          db
            .select()
            .from(messages)
            .where(and(eq(messages.id, opts.cursor!), eq(messages.chatId, chatId)))
            .limit(1) as Promise<Message[]>,
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (cursorRows.length === 0) {
        return yield* Effect.fail(new ValidationError({ cause: "Unknown cursor for this chat" }));
      }
      // Composite keyset (createdAt, id): created_at has SECOND resolution and
      // is not unique, so a strict `createdAt <` alone silently skips every
      // message sharing the cursor's second — the ordinary case for a burst of
      // replies, and unreachable for ever once the page moves past it. Same
      // pattern as `listChats` and `getChatMembers`.
      const cursor = cursorRows[0]!;
      conditions.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        )!,
      );
    }

    const results = yield* Effect.tryPromise({
      try: (): Promise<Message[]> =>
        db
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(limit) as Promise<Message[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricMessagesListed(results.length);
    return results;
  }).pipe(Effect.withSpan("zap.messages.list"));

export const sendC2bMessage = (
  chatId: string,
  senderProfileId: string,
  data: unknown,
): Effect.Effect<
  Message,
  ChatNotFound | NotChatMember | NotC2bChat | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Verify chat exists and sender is a member in one LEFT JOIN, in place of
    // the separate SELECT + assertMember round trips this used to make.
    const rows = yield* Effect.tryPromise({
      try: (): Promise<{ chat: Chat; memberId: string | null }[]> =>
        db
          .select({ chat: chats, memberId: chatMembers.id })
          .from(chats)
          .leftJoin(
            chatMembers,
            and(eq(chatMembers.chatId, chats.id), eq(chatMembers.profileId, senderProfileId)),
          )
          .where(eq(chats.id, chatId))
          .limit(1) as Promise<{ chat: Chat; memberId: string | null }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id: chatId }));
    }
    const { chat, memberId } = rows[0]!;

    // Assert this is a c2b chat — BEFORE the membership check, the mirror
    // image of `sendMessage`'s ordering. That route is public, so membership
    // has to come first there or a stranger holding a chat id could tell a
    // c2c chat from a c2b one. This route is ARC-gated and only cire calls
    // it — there's no untrusted caller to withhold class from — so checking
    // class first means a c2c chat id passed here by mistake comes back
    // `NotC2bChat`, the real reason, instead of a manufactured `NotChatMember`
    // that would send an integrator debugging the wrong thing.
    if (chat.class !== "c2b") {
      return yield* Effect.fail(new NotC2bChat({ chatId }));
    }

    if (memberId === null) {
      return yield* Effect.fail(new NotChatMember({ chatId }));
    }

    const validated = yield* Schema.decodeUnknown(SendC2bMessageSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const id = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = storedNow();

    const row: Message = {
      id,
      chatId,
      senderProfileId,
      ciphertext: null,
      nonce: null,
      body: validated.body,
      createdAt: now,
      expiresAt: null,
    };

    // One hop instead of two sequential writes. Atomic on D1 (`db.batch`); on
    // bun:sqlite `commitBatch` chains the statements sequentially with no
    // rollback, which is not a regression versus the two separate awaits this
    // replaces — no test may assert joint rollback there.
    yield* Effect.tryPromise({
      try: () =>
        commitBatch(db, [
          db.insert(messages).values(row),
          db.update(chats).set({ updatedAt: now }).where(eq(chats.id, chatId)),
        ]),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Returned from the values just written rather than read back. Every
    // column is known here — nothing is defaulted or computed by the database
    // — so the read was a third sequential round-trip that could only return
    // what we already had.
    return row;
  }).pipe(Effect.withSpan("zap.messages.send_c2b"));

export const listC2bMessages = (
  chatId: string,
  opts: { limit?: number; before?: string } = {},
): Effect.Effect<Message[], ChatNotFound | NotC2bChat | ValidationError | DatabaseError, Db> =>
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

    // Assert this is a c2b chat.
    if (chat.class !== "c2b") {
      return yield* Effect.fail(new NotC2bChat({ chatId }));
    }

    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT);

    // Cursor-based pagination: fetch messages older than `before` message id.
    const conditions = [eq(messages.chatId, chatId)];
    if (opts.before) {
      const cursorRows = yield* Effect.tryPromise({
        try: (): Promise<Message[]> =>
          db
            .select()
            .from(messages)
            .where(and(eq(messages.id, opts.before!), eq(messages.chatId, chatId)))
            .limit(1) as Promise<Message[]>,
        catch: (cause) => new DatabaseError({ cause }),
      });
      // Same contract as `listMessages`: an unknown cursor is a caller bug,
      // not page 1. Silently restarting sends the caller round the same page
      // for ever, and it cannot tell that from a genuinely short history.
      if (cursorRows.length === 0) {
        return yield* Effect.fail(new ValidationError({ cause: "Unknown cursor for this chat" }));
      }
      // Composite keyset (createdAt, id): created_at has SECOND resolution and
      // is not unique, so a strict `createdAt <` alone silently skips every
      // message sharing the cursor's second — the ordinary case for a burst of
      // replies, and unreachable for ever once the page moves past it. Same
      // pattern as `listChats` and `getChatMembers`.
      const cursor = cursorRows[0]!;
      conditions.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        )!,
      );
    }

    const results = yield* Effect.tryPromise({
      try: (): Promise<Message[]> =>
        db
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(limit) as Promise<Message[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricMessagesListed(results.length);
    return results;
  }).pipe(Effect.withSpan("zap.messages.list_c2b"));
