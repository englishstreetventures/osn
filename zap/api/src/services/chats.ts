import { chats, chatMembers } from "@zap/db/schema";
import type { Chat, ChatMember } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { and, asc, count, desc, eq, lt, or } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  DEFAULT_CHAT_LIMIT,
  DEFAULT_MEMBER_LIMIT,
  MAX_CHAT_LIMIT,
  MAX_CHAT_MEMBERS,
  MAX_CHAT_TITLE_LENGTH,
  MAX_MEMBER_LIMIT,
} from "../lib/limits";
import { metricChatCreated, metricMemberAdded, metricMemberRemoved } from "../metrics";
import { checkConsent, ConsentDenied } from "./consent";

// Re-export so routes catch the consent failure via the chats service barrel.
export { ConsentDenied } from "./consent";

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
  readonly profileId: string;
}> {}

/** Z3 — a DM must have exactly two members (creator + one other). */
export class InvalidDmMembership extends Data.TaggedError("InvalidDmMembership")<{
  readonly memberCount: number;
}> {}

/** Z5 — cannot remove the last admin of a chat. */
export class LastAdmin extends Data.TaggedError("LastAdmin")<{
  readonly chatId: string;
}> {}

/** Emitted when a c2b-only operation is attempted on a c2c chat. */
export class NotC2bChat extends Data.TaggedError("NotC2bChat")<{
  readonly chatId: string;
}> {}

// ---------------------------------------------------------------------------
// Effect schemas (service-layer validation)
// ---------------------------------------------------------------------------

const ChatTypeEnum = Schema.Literal("dm", "group", "event");
const TitleString = Schema.String.pipe(Schema.maxLength(MAX_CHAT_TITLE_LENGTH));

const ProvisionC2bChatSchema = Schema.Struct({
  memberProfileIds: Schema.Array(Schema.String).pipe(Schema.minItems(2)),
  createdByProfileId: Schema.String,
  title: Schema.optional(TitleString),
});

const CreateChatSchema = Schema.Struct({
  type: ChatTypeEnum,
  title: Schema.optional(TitleString),
  eventId: Schema.optional(Schema.String),
  memberProfileIds: Schema.optional(Schema.Array(Schema.String)),
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

export const listChats = (
  profileId: string,
  opts: { limit?: number; cursor?: string } = {},
): Effect.Effect<
  { chats: Chat[]; nextCursor: string | null; hasMore: boolean },
  ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // P-W1: bounded page size — default 50, cap 100, floor 1.
    const requested = Number.isFinite(opts.limit) ? (opts.limit as number) : DEFAULT_CHAT_LIMIT;
    const limit = Math.min(Math.max(1, requested), MAX_CHAT_LIMIT);

    // Cursor-based pagination: fetch chats older than the cursor (newest first).
    const conditions = [eq(chatMembers.profileId, profileId)];
    if (opts.cursor) {
      // Mirrors the hardened listMessages cursor contract: the cursor is a
      // chat ID. Scope the lookup to the CALLER'S chats (membership join) so a
      // cursor naming someone else's chat can't be used to probe chat timing,
      // and reject an unknown/foreign cursor with a validation error instead
      // of silently falling back to page 1.
      const cursorRows = yield* Effect.tryPromise({
        try: (): Promise<{ createdAt: Date; id: string }[]> =>
          db
            .select({ createdAt: chats.createdAt, id: chats.id })
            .from(chats)
            .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
            .where(and(eq(chats.id, opts.cursor!), eq(chatMembers.profileId, profileId)))
            .limit(1) as Promise<{ createdAt: Date; id: string }[]>,
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (cursorRows.length === 0) {
        return yield* Effect.fail(new ValidationError({ cause: "Unknown cursor for this user" }));
      }
      // Composite keyset (createdAt, id): created_at has SECOND resolution and
      // is not unique, so a strict `createdAt <` alone would silently skip any
      // chat sharing the cursor's second (the expected case for creation
      // bursts). The id tiebreak makes pages disjoint and exhaustive — same
      // pattern as getChatMembers' (joinedAt, id) ordering.
      const cur = cursorRows[0]!;
      conditions.push(
        or(
          lt(chats.createdAt, cur.createdAt),
          and(eq(chats.createdAt, cur.createdAt), lt(chats.id, cur.id)),
        )!,
      );
    }

    // Single membership-joined query, newest first, bounded by limit —
    // replaces the old fetch-all-memberships + inArray fetch-all-chats pair.
    // Fetch limit + 1 so the presence of a next page costs one extra row
    // instead of one extra request.
    const rows = yield* Effect.tryPromise({
      try: (): Promise<{ chat: Chat }[]> =>
        db
          .select({ chat: chats })
          .from(chats)
          .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
          .where(and(...conditions))
          .orderBy(desc(chats.createdAt), desc(chats.id))
          .limit(limit + 1) as Promise<{ chat: Chat }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).map((r) => r.chat);
    return {
      chats: page,
      hasMore,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
    };
  }).pipe(Effect.withSpan("zap.chats.list"));

export const createChat = (
  data: unknown,
  creatorProfileId: string,
): Effect.Effect<Chat, ValidationError | ConsentDenied | InvalidDmMembership | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const validated = yield* Schema.decodeUnknown(CreateChatSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    // De-dupe initial members and drop the creator (added as admin below).
    const initialMembers = Array.from(
      new Set((validated.memberProfileIds ?? []).filter((uid) => uid !== creatorProfileId)),
    );

    // Z3: a DM is exactly two people — the creator plus one other. Anything
    // else is a group/event chat and must be created as one.
    if (validated.type === "dm" && initialMembers.length !== 1) {
      return yield* Effect.fail(
        new InvalidDmMembership({ memberCount: initialMembers.length + 1 }),
      );
    }

    // Z3/Z4: every profile pulled into the chat must consent (graph-gated).
    // Fail-closed on graph-unreachable. Checked BEFORE any insert so a denied
    // member never leaves a half-built chat behind. P-W1: run the per-member
    // S2S consent checks with bounded concurrency (up to MAX_CHAT_MEMBERS) so
    // they overlap instead of serialising one round-trip at a time; any
    // rejection still short-circuits (Effect.forEach fails fast), preserving
    // the fail-closed contract.
    yield* Effect.forEach(initialMembers, (targetId) => checkConsent(creatorProfileId, targetId), {
      concurrency: 10,
      discard: true,
    });

    const id = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();

    yield* Effect.tryPromise({
      try: () =>
        db.insert(chats).values({
          id,
          type: validated.type,
          title: validated.title ?? null,
          eventId: validated.eventId ?? null,
          createdByProfileId: creatorProfileId,
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
          profileId: creatorProfileId,
          role: "admin",
          joinedAt: now,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Batch-insert initial members (already consent-checked + de-duped).
    if (initialMembers.length > 0) {
      const memberRows = initialMembers.map((uid) => ({
        id: "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        chatId: id,
        profileId: uid,
        role: "member" as const,
        joinedAt: now,
      }));
      yield* Effect.tryPromise({
        try: () => db.insert(chatMembers).values(memberRows),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }

    metricChatCreated(validated.type, "ok");
    return yield* getChat(id).pipe(
      Effect.mapError((e) => (e instanceof ChatNotFound ? new DatabaseError({ cause: e }) : e)),
    );
  }).pipe(Effect.withSpan("zap.chats.create"));

export const updateChat = (
  id: string,
  data: unknown,
  requestingProfileId: string,
): Effect.Effect<Chat, ChatNotFound | NotChatAdmin | ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* getChat(id);

    // Check that the requesting user is an admin.
    yield* assertAdmin(id, requestingProfileId);

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
  profileId: string,
  requestingProfileId: string,
): Effect.Effect<
  ChatMember,
  | ChatNotFound
  | NotChatAdmin
  | MemberLimitReached
  | AlreadyMember
  | ConsentDenied
  | InvalidDmMembership
  | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const chat = yield* getChat(chatId);
    yield* assertAdmin(chatId, requestingProfileId);

    // Z3: a DM is sealed at two members — no widening into a group via add.
    if (chat.type === "dm") {
      return yield* Effect.fail(new InvalidDmMembership({ memberCount: 3 }));
    }

    // Z3/Z4: the actor must share a permitted graph relationship with the
    // profile being added. Fail-closed on graph-unreachable.
    yield* checkConsent(requestingProfileId, profileId);

    // P-W2: check the member count with COUNT(*) instead of loading every
    // member row (up to MAX_CHAT_MEMBERS) into memory.
    const countRows = yield* Effect.tryPromise({
      try: (): Promise<{ value: number }[]> =>
        db
          .select({ value: count() })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId)) as Promise<{ value: number }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if ((countRows[0]?.value ?? 0) >= MAX_CHAT_MEMBERS) {
      return yield* Effect.fail(new MemberLimitReached({ chatId }));
    }

    // Check if already a member (single indexed lookup on the unique pair).
    const duplicate = yield* Effect.tryPromise({
      try: (): Promise<{ id: string }[]> =>
        db
          .select({ id: chatMembers.id })
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.profileId, profileId)))
          .limit(1) as Promise<{ id: string }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (duplicate.length > 0) {
      return yield* Effect.fail(new AlreadyMember({ chatId, profileId }));
    }

    const id = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db.insert(chatMembers).values({
          id,
          chatId,
          profileId,
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
  profileId: string,
  requestingProfileId: string,
): Effect.Effect<
  void,
  ChatNotFound | NotChatAdmin | NotChatMember | LastAdmin | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* getChat(chatId);

    // Allow self-removal (leaving) or admin removal of others.
    if (profileId !== requestingProfileId) {
      yield* assertAdmin(chatId, requestingProfileId);
    }

    // Verify the target is a member.
    const memberRows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db
          .select()
          .from(chatMembers)
          .where(
            and(eq(chatMembers.chatId, chatId), eq(chatMembers.profileId, profileId)),
          ) as Promise<ChatMember[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (memberRows.length === 0) {
      return yield* Effect.fail(new NotChatMember({ chatId }));
    }

    // Z5: never strand a chat with zero admins. If the target is the last
    // remaining admin, the removal (self-leave included) is rejected — an
    // admin must hand off the role first.
    if (memberRows[0]!.role === "admin") {
      const adminRows = yield* Effect.tryPromise({
        try: (): Promise<ChatMember[]> =>
          db
            .select()
            .from(chatMembers)
            .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.role, "admin"))) as Promise<
            ChatMember[]
          >,
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (adminRows.length <= 1) {
        return yield* Effect.fail(new LastAdmin({ chatId }));
      }
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .delete(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.profileId, profileId))),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricMemberRemoved("ok");
  }).pipe(Effect.withSpan("zap.chats.remove_member"));

export const getChatMembers = (
  chatId: string,
  opts: { limit?: number; offset?: number; assertedExists?: boolean } = {},
): Effect.Effect<{ members: ChatMember[]; hasMore: boolean }, ChatNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    // P-I5: callers that already gated on assertMember have proven the chat
    // exists (a membership row FK-references it) — skip the redundant load.
    // Un-gated callers keep the 404 contract.
    if (!opts.assertedExists) {
      yield* getChat(chatId);
    }

    // P-W4: limit/offset pagination — members are bounded at MAX_CHAT_MEMBERS
    // (500), so offset paging is stable enough. Default 100, cap 500, floor 1.
    const requested = Number.isFinite(opts.limit) ? (opts.limit as number) : DEFAULT_MEMBER_LIMIT;
    const limit = Math.min(Math.max(1, requested), MAX_MEMBER_LIMIT);
    const offset = Number.isFinite(opts.offset) ? Math.max(0, opts.offset as number) : 0;

    // limit + 1: next-page presence for one extra row, not one extra request.
    const rows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db
          .select()
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId))
          // Deterministic page order: joinedAt, then id as tiebreak (batch
          // inserts share a joinedAt timestamp).
          .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.id))
          .limit(limit + 1)
          .offset(offset) as Promise<ChatMember[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    const hasMore = rows.length > limit;
    return { members: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }).pipe(Effect.withSpan("zap.chats.get_members"));

export const provisionC2bChat = (input: {
  memberProfileIds: readonly string[];
  createdByProfileId: string;
  title?: string;
}): Effect.Effect<Chat, ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const validated = yield* Schema.decodeUnknown(ProvisionC2bChatSchema)(input).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    // De-dupe members; enforce 2..MAX_CHAT_MEMBERS inclusive.
    const memberSet = Array.from(new Set(validated.memberProfileIds));
    if (memberSet.length < 2 || memberSet.length > MAX_CHAT_MEMBERS) {
      return yield* Effect.fail(
        new ValidationError({ cause: `member count must be 2..${MAX_CHAT_MEMBERS}` }),
      );
    }

    const id = "chat_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();

    yield* Effect.tryPromise({
      try: () =>
        db.insert(chats).values({
          id,
          type: "group",
          class: "c2b",
          title: validated.title ?? null,
          eventId: null,
          createdByProfileId: validated.createdByProfileId,
          createdAt: now,
          updatedAt: now,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Insert all members (no role distinction — cire is the trusted authorizer).
    const memberRows = memberSet.map((profileId) => ({
      id: "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      chatId: id,
      profileId,
      role: "member" as const,
      joinedAt: now,
    }));
    yield* Effect.tryPromise({
      try: () => db.insert(chatMembers).values(memberRows),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return yield* getChat(id).pipe(
      Effect.mapError((e) => (e instanceof ChatNotFound ? new DatabaseError({ cause: e }) : e)),
    );
  }).pipe(Effect.withSpan("zap.chats.provision_c2b"));

// ---------------------------------------------------------------------------
// Helpers (public — used by routes for membership gating)
// ---------------------------------------------------------------------------

export const assertMember = (
  chatId: string,
  profileId: string,
): Effect.Effect<void, NotChatMember | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<ChatMember[]> =>
        db
          .select()
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.profileId, profileId)))
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
  profileId: string,
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
              eq(chatMembers.profileId, profileId),
              eq(chatMembers.role, "admin"),
            ),
          ) as Promise<ChatMember[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new NotChatAdmin({ chatId }));
    }
  });
