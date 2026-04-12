import { chats, chatMembers } from "@zap/db/schema";
import type { Chat, ChatMember } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { and, eq, inArray } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import { MAX_CHAT_MEMBERS, MAX_CHAT_TITLE_LENGTH } from "../lib/limits";
import { metricChatCreated, metricMemberAdded, metricMemberRemoved } from "../metrics";

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

export class ChatNotFound extends Data.TaggedError("ChatNotFound")<{
  readonly id: string;
}> {}

export class NotChatMember extends Data.TaggedError("NotChatMember")<{
  readonly chatId: string;
}> {}

export class NotChatAdmin extends Data.TaggedError("NotChatAdmin")<{
  readonly chatId: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

export class MemberLimitReached extends Data.TaggedError("MemberLimitReached")<{
  readonly chatId: string;
}> {}

export class AlreadyMember extends Data.TaggedError("AlreadyMember")<{
  readonly chatId: string;
  readonly userId: string;
}> {}

// ---------------------------------------------------------------------------
// Effect schemas (service-layer validation)
// ---------------------------------------------------------------------------

const ChatTypeEnum = Schema.Literal("dm", "group", "event");
const TitleString = Schema.String.pipe(Schema.maxLength(MAX_CHAT_TITLE_LENGTH));

const CreateChatSchema = Schema.Struct({
  type: ChatTypeEnum,
  title: Schema.optional(TitleString),
  eventId: Schema.optional(Schema.String),
  memberUserIds: Schema.optional(Schema.Array(Schema.String)),
});

const UpdateChatSchema = Schema.Struct({
  title: Schema.optional(TitleString),
});

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export const getChat = (id: string): Effect.Effect<Chat, ChatNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const result = yield* Effect.tryPromise({
      try: (): Promise<Chat[]> =>
        db.select().from(chats).where(eq(chats.id, id)).limit(1) as Promise<Chat[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (result.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id }));
    }
    return result[0]!;
  }).pipe(Effect.withSpan("zap.chats.get"));

export const listChats = (userId: string): Effect.Effect<Chat[], DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    // Find all chats the user is a member of.
    const memberRows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db.select().from(chatMembers).where(eq(chatMembers.userId, userId)) as Promise<
          ChatMember[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (memberRows.length === 0) return [];
    const chatIds = memberRows.map((m) => m.chatId);
    const results = yield* Effect.tryPromise({
      try: (): Promise<Chat[]> =>
        db.select().from(chats).where(inArray(chats.id, chatIds)) as Promise<Chat[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    return results;
  }).pipe(Effect.withSpan("zap.chats.list"));

export const createChat = (
  data: unknown,
  creatorUserId: string,
): Effect.Effect<Chat, ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const validated = yield* Schema.decodeUnknown(CreateChatSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const id = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();

    yield* Effect.tryPromise({
      try: () =>
        db.insert(chats).values({
          id,
          type: validated.type,
          title: validated.title ?? null,
          eventId: validated.eventId ?? null,
          createdByUserId: creatorUserId,
          createdAt: now,
          updatedAt: now,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Add creator as admin member.
    const memberId = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    yield* Effect.tryPromise({
      try: () =>
        db.insert(chatMembers).values({
          id: memberId,
          chatId: id,
          userId: creatorUserId,
          role: "admin",
          joinedAt: now,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Batch-insert initial members if provided.
    if (validated.memberUserIds && validated.memberUserIds.length > 0) {
      const memberRows = validated.memberUserIds
        .filter((uid) => uid !== creatorUserId) // already added as admin
        .map((uid) => ({
          id: "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          chatId: id,
          userId: uid,
          role: "member" as const,
          joinedAt: now,
        }));
      if (memberRows.length > 0) {
        yield* Effect.tryPromise({
          try: () => db.insert(chatMembers).values(memberRows),
          catch: (cause) => new DatabaseError({ cause }),
        });
      }
    }

    metricChatCreated(validated.type, "ok");
    return yield* getChat(id).pipe(
      Effect.mapError((e) => (e instanceof ChatNotFound ? new DatabaseError({ cause: e }) : e)),
    );
  }).pipe(Effect.withSpan("zap.chats.create"));

export const updateChat = (
  id: string,
  data: unknown,
  requestingUserId: string,
): Effect.Effect<Chat, ChatNotFound | NotChatAdmin | ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* getChat(id);

    // Check that the requesting user is an admin.
    yield* assertAdmin(id, requestingUserId);

    const validated = yield* Schema.decodeUnknown(UpdateChatSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db.update(chats).set({ title: validated.title, updatedAt: now }).where(eq(chats.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return yield* getChat(id);
  }).pipe(Effect.withSpan("zap.chats.update"));

export const addMember = (
  chatId: string,
  userId: string,
  requestingUserId: string,
): Effect.Effect<
  ChatMember,
  ChatNotFound | NotChatAdmin | MemberLimitReached | AlreadyMember | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* getChat(chatId);
    yield* assertAdmin(chatId, requestingUserId);

    // Check member count.
    const existing = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db.select().from(chatMembers).where(eq(chatMembers.chatId, chatId)) as Promise<
          ChatMember[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (existing.length >= MAX_CHAT_MEMBERS) {
      return yield* Effect.fail(new MemberLimitReached({ chatId }));
    }

    // Check if already a member.
    const alreadyExists = existing.some((m) => m.userId === userId);
    if (alreadyExists) {
      return yield* Effect.fail(new AlreadyMember({ chatId, userId }));
    }

    const id = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db.insert(chatMembers).values({
          id,
          chatId,
          userId,
          role: "member",
          joinedAt: now,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricMemberAdded("ok");

    const [member] = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db.select().from(chatMembers).where(eq(chatMembers.id, id)) as Promise<ChatMember[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    return member!;
  }).pipe(Effect.withSpan("zap.chats.add_member"));

export const removeMember = (
  chatId: string,
  userId: string,
  requestingUserId: string,
): Effect.Effect<void, ChatNotFound | NotChatAdmin | NotChatMember | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* getChat(chatId);

    // Allow self-removal (leaving) or admin removal of others.
    if (userId !== requestingUserId) {
      yield* assertAdmin(chatId, requestingUserId);
    }

    // Verify the target is a member.
    const memberRows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db
          .select()
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId))) as Promise<
          ChatMember[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (memberRows.length === 0) {
      return yield* Effect.fail(new NotChatMember({ chatId }));
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .delete(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId))),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricMemberRemoved("ok");
  }).pipe(Effect.withSpan("zap.chats.remove_member"));

export const getChatMembers = (
  chatId: string,
): Effect.Effect<ChatMember[], ChatNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* getChat(chatId);
    const members = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db.select().from(chatMembers).where(eq(chatMembers.chatId, chatId)) as Promise<
          ChatMember[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    return members;
  }).pipe(Effect.withSpan("zap.chats.get_members"));

// ---------------------------------------------------------------------------
// Helpers (public — used by routes for membership gating)
// ---------------------------------------------------------------------------

export const assertMember = (
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const assertAdmin = (
  chatId: string,
  userId: string,
): Effect.Effect<void, NotChatAdmin | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db
          .select()
          .from(chatMembers)
          .where(
            and(
              eq(chatMembers.chatId, chatId),
              eq(chatMembers.userId, userId),
              eq(chatMembers.role, "admin"),
            ),
          ) as Promise<ChatMember[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new NotChatAdmin({ chatId }));
    }
  });
