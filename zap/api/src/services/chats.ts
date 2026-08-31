import { commitBatch } from "@shared/db-utils";
import { chats, chatMembers } from "@zap/db/schema";
import type { Chat, ChatMember } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { and, asc, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  DEFAULT_CHAT_LIMIT,
  DEFAULT_MEMBER_LIMIT,
  MAX_CHAT_LIMIT,
  MAX_CHAT_MEMBERS,
  MAX_CHAT_TITLE_LENGTH,
  MAX_MEMBER_LIMIT,
  MAX_MEMBER_ROWS_PER_INSERT,
} from "../lib/limits";
import { storedNow } from "../lib/storedNow";
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

/**
 * The mirror: a c2c-only operation attempted on a c2b chat.
 *
 * `class` is the encryption and visibility contract — a c2b chat is
 * server-visible, moderatable and DSAR-exportable by definition. An encrypted
 * message written into one is none of those: the export filters on a non-null
 * `body` so the row is dropped silently, and the internal reader renders it as
 * an empty string with no signal that content was withheld. Both write paths
 * have to enforce the column or it stops describing the rows underneath it.
 */
export class NotC2cChat extends Data.TaggedError("NotC2cChat")<{
  readonly chatId: string;
}> {}

// ---------------------------------------------------------------------------
// Effect schemas (service-layer validation)
// ---------------------------------------------------------------------------

const ChatTypeEnum = Schema.Literal("dm", "group", "event");
const TitleString = Schema.String.pipe(Schema.maxLength(MAX_CHAT_TITLE_LENGTH));

const ProvisionC2bChatSchema = Schema.Struct({
  memberProfileIds: Schema.Array(Schema.String).pipe(
    Schema.minItems(2),
    Schema.maxItems(MAX_CHAT_MEMBERS),
  ),
  createdByProfileId: Schema.String,
  title: Schema.optional(TitleString),
});

const CreateChatSchema = Schema.Struct({
  type: ChatTypeEnum,
  title: Schema.optional(TitleString),
  eventId: Schema.optional(Schema.String),
  memberProfileIds: Schema.optional(
    Schema.Array(Schema.String).pipe(Schema.maxItems(MAX_CHAT_MEMBERS)),
  ),
});

const UpdateChatSchema = Schema.Struct({
  title: Schema.optional(TitleString),
});

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Splits an array of already-built row objects into chunks of at most
 * `size`. Used to keep a single batched INSERT's bound-parameter count under
 * D1's per-query ceiling — chunking rows, not pre-built statement groups, so
 * this is a fresh, differently-shaped helper from `cire/api`'s
 * `chunkGroups`, not a port of it.
 */
const chunkRows = <T>(rows: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
};

/**
 * Detects a SQLite unique-constraint failure by walking a bounded number of
 * `.cause` levels (5) and testing each level's `message`.
 *
 * D1's session wraps every failure in `DrizzleQueryError`
 * (`drizzle-orm/d1/session.js`): the top-level `.message` is `"Failed
 * query: …"` and the driver error carrying `UNIQUE constraint failed:
 * chat_members.chat_id, chat_members.profile_id` sits one level down in
 * `.cause`. bun:sqlite's session does not wrap (no `queryWithCache` call in
 * `drizzle-orm/bun-sqlite/session.js`), so locally the substring is already
 * at the top level — walking still finds it there on the first iteration.
 * Matches on the message substring only, never on the constraint name
 * (`chat_members_pair_idx`), which never appears in the error text.
 */
export const isUniqueConstraintFailure = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!(current instanceof Error)) {
      return false;
    }
    if (current.message.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = current.cause;
  }
  return false;
};

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
    const now = storedNow();

    // `class` is written explicitly rather than left to the column default.
    // The row below is what the caller gets back, so a value the database
    // fills in is a value this object would have to guess — and guessing it
    // wrong is the failure mode the removed read-back used to hide.
    const row: Chat = {
      id,
      type: validated.type,
      class: "c2c",
      title: validated.title ?? null,
      eventId: validated.eventId ?? null,
      createdByProfileId: creatorProfileId,
      createdAt: now,
      updatedAt: now,
    };

    // Creator as admin, plus the already consent-checked + de-duped initial
    // members — one row array, one batch, rather than three sequential
    // round trips.
    const creatorMemberRow = {
      id: "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      chatId: id,
      profileId: creatorProfileId,
      role: "admin" as const,
      joinedAt: now,
    };
    const otherMemberRows = initialMembers.map((uid) => ({
      id: "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      chatId: id,
      profileId: uid,
      role: "member" as const,
      joinedAt: now,
    }));
    const allMemberRows = [creatorMemberRow, ...otherMemberRows];

    // FK-first ordering: the chat row is inserted before any member row,
    // which references it. Chunked at MAX_MEMBER_ROWS_PER_INSERT rows per
    // INSERT to stay under D1's ~100-bound-parameter ceiling — up to
    // MAX_CHAT_MEMBERS+1 (501) member rows here (the creator plus up to
    // MAX_CHAT_MEMBERS others, the schema's cap on `memberProfileIds`)
    // chunks into ceil(501/20) = 26 INSERTs, plus the chat INSERT itself =
    // 27 statements — under D1's 50-queries-per-invocation Free-tier bound.
    // Atomic on D1 (`db.batch`); on bun:sqlite `commitBatch` chains the
    // statements sequentially with no rollback, which is not a regression
    // versus the three separate awaits this replaces — no test may assert
    // joint rollback there.
    yield* Effect.tryPromise({
      try: () =>
        commitBatch(db, [
          db.insert(chats).values(row),
          ...chunkRows(allMemberRows, MAX_MEMBER_ROWS_PER_INSERT).map((chunk) =>
            db.insert(chatMembers).values(chunk),
          ),
        ]),
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricChatCreated(validated.type, "ok");
    // Returned from the values just written — see `provisionC2bChat`.
    return row;
  }).pipe(Effect.withSpan("zap.chats.create"));

/**
 * Rejects a `c2b` chat on the public, member-facing API.
 *
 * `class` is not a per-verb rule. A c2b chat's membership is cire's to grant
 * and revoke through the ARC-gated internal routes, and its messages are
 * server-visible by definition — so every c2c-shaped operation has to refuse
 * one, whether it reads, writes or changes who is in it. Without that, the
 * guards depend on accidents: a c2b chat has no admin (`provisionC2bChat`
 * writes `role: "member"` for everyone), so `assertAdmin` happens to close
 * the admin-only paths, and the first flow that promotes a c2b member opens
 * them all again.
 */
const assertC2c = (chat: Chat): Effect.Effect<void, NotC2cChat> =>
  chat.class === "c2c" ? Effect.void : Effect.fail(new NotC2cChat({ chatId: chat.id }));

export const updateChat = (
  id: string,
  data: unknown,
  requestingProfileId: string,
): Effect.Effect<
  Chat,
  ChatNotFound | NotChatAdmin | NotC2cChat | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    // The row this returns, built from what was already read plus what is
    // about to be written — so the second `getChat` that used to follow the
    // update is gone. `storedNow()` is what makes that safe: Drizzle stores a
    // timestamp as whole seconds, and an untruncated `Date` here would make
    // the response disagree with every later read of the same row.
    //
    // One LEFT JOIN replaces the separate `getChat` + `assertAdmin` lookups —
    // the nested `chat` projection carries the whole row (this function
    // spreads `{ ...chat, ... }` below) and `role` says whether the
    // requester is a member at all.
    const rows = yield* Effect.tryPromise({
      try: (): Promise<{ chat: Chat; role: ChatMember["role"] | null }[]> =>
        db
          .select({ chat: chats, role: chatMembers.role })
          .from(chats)
          .leftJoin(
            chatMembers,
            and(eq(chatMembers.chatId, chats.id), eq(chatMembers.profileId, requestingProfileId)),
          )
          .where(eq(chats.id, id))
          .limit(1) as Promise<{ chat: Chat; role: ChatMember["role"] | null }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id }));
    }
    const { chat, role } = rows[0]!;

    // `role` null (no membership row) or a non-"admin" role both mean "not an
    // admin" and must fail `NotChatAdmin`, never `NotChatMember` — the
    // deleted `assertAdmin` filtered `role = 'admin'` in its WHERE clause, so
    // a non-admin AND a non-member both fell through to `NotChatAdmin`. A
    // "natural" fold that maps the null case to `NotChatMember` would
    // silently change this route's status from 403 to 404.
    if (role !== "admin") {
      return yield* Effect.fail(new NotChatAdmin({ chatId: id }));
    }

    // After the authorisation gate, not before — see `addMember`. A 409 "not
    // a c2c chat" reaching a caller with no standing in the chat would tell
    // them the id names a commercial conversation.
    yield* assertC2c(chat);

    const validated = yield* Schema.decodeUnknown(UpdateChatSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const now = storedNow();
    yield* Effect.tryPromise({
      try: () =>
        db.update(chats).set({ title: validated.title, updatedAt: now }).where(eq(chats.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // `?? chat.title`, not `validated.title`. Drizzle omits an `undefined`
    // field from the SET clause, so a request that sends no title leaves the
    // stored one alone — and the row handed back has to say the same. The
    // read-back this replaced got that right by accident; the compiler caught
    // it here, which is the argument for annotating these rows at all.
    // `=== undefined`, not `??`. Drizzle filters exactly `undefined` out of
    // the SET clause; a `null` would be written. The schema rejects `null`
    // today, so the two behave alike — but the moment "send null to clear the
    // title" is added, `??` would write NULL and hand the caller back the old
    // title, breaking the one property this conversion rests on.
    return {
      ...chat,
      title: validated.title === undefined ? chat.title : validated.title,
      updatedAt: now,
    };
  }).pipe(Effect.withSpan("zap.chats.update"));

export const addMember = (
  chatId: string,
  profileId: string,
  requestingProfileId: string,
): Effect.Effect<
  ChatMember,
  | ChatNotFound
  | NotChatAdmin
  | NotC2cChat
  | MemberLimitReached
  | AlreadyMember
  | ConsentDenied
  | InvalidDmMembership
  | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    // One LEFT JOIN replaces the separate `getChat` + `assertAdmin` lookups —
    // see `updateChat` for the same fold and the same null-vs-non-admin note.
    const chatRows = yield* Effect.tryPromise({
      try: (): Promise<{ chat: Chat; role: ChatMember["role"] | null }[]> =>
        db
          .select({ chat: chats, role: chatMembers.role })
          .from(chats)
          .leftJoin(
            chatMembers,
            and(eq(chatMembers.chatId, chats.id), eq(chatMembers.profileId, requestingProfileId)),
          )
          .where(eq(chats.id, chatId))
          .limit(1) as Promise<{ chat: Chat; role: ChatMember["role"] | null }[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (chatRows.length === 0) {
      return yield* Effect.fail(new ChatNotFound({ id: chatId }));
    }
    const { chat, role } = chatRows[0]!;
    // `role` null (no membership row) or a non-"admin" role both fail
    // `NotChatAdmin`, never `NotChatMember` — see `updateChat`'s fold for why.
    if (role !== "admin") {
      return yield* Effect.fail(new NotChatAdmin({ chatId }));
    }

    // After the authorisation gate, not before. `assertC2c` answers 409 "not a
    // c2c chat", which to a caller with no standing in the chat would say the
    // id names a commercial conversation — the same disclosure the two public
    // message routes order around. Members and admins already know.
    yield* assertC2c(chat);

    // Z3: a DM is sealed at two members — no widening into a group via add.
    if (chat.type === "dm") {
      return yield* Effect.fail(new InvalidDmMembership({ memberCount: 3 }));
    }

    // Z3/Z4: the actor must share a permitted graph relationship with the
    // profile being added. Fail-closed on graph-unreachable.
    yield* checkConsent(requestingProfileId, profileId);

    // P-W2/cap+duplicate fold: one query over chat_members instead of a
    // COUNT(*) followed by a separate indexed duplicate lookup. `sum()` from
    // drizzle-orm 0.45.2 is typed `SQL<string | null>`
    // (`sql\`sum(...)\`.mapWith(String)`), which does not typecheck against a
    // numeric comparison — the raw `sql<number>` template is used instead.
    // `sum` over zero matching rows is SQL NULL, hence the `dup ?? 0` guard;
    // `count()` already maps with `Number`, so `total` needs no guard.
    const capRows = yield* Effect.tryPromise({
      try: (): Promise<{ total: number; dup: number | null }[]> =>
        db
          .select({
            total: count(),
            dup: sql<number>`sum(${chatMembers.profileId} = ${profileId})`,
          })
          .from(chatMembers)
          .where(eq(chatMembers.chatId, chatId)) as Promise<
          { total: number; dup: number | null }[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    const { total, dup } = capRows[0]!;
    if (total >= MAX_CHAT_MEMBERS) {
      return yield* Effect.fail(new MemberLimitReached({ chatId }));
    }
    if ((dup ?? 0) > 0) {
      return yield* Effect.fail(new AlreadyMember({ chatId, profileId }));
    }

    const id = "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = storedNow();
    // Annotated `: ChatMember` so every column is required here — a column
    // added to the schema later breaks the build rather than quietly going
    // missing from what callers get back.
    const row: ChatMember = {
      id,
      chatId,
      profileId,
      role: "member",
      joinedAt: now,
    };
    // The cap/duplicate check above narrows the concurrent-duplicate window
    // but cannot close it (P-I/TOCTOU) — two concurrent adds of the *same*
    // profile can both pass it and both reach this INSERT. The unique
    // constraint on (chat_id, profile_id) is the real guard: catch its
    // failure and resolve to `AlreadyMember` (409) rather than `DatabaseError`
    // (500). This fixes concurrent duplicate adds only — the member *cap* has
    // a separate, pre-existing TOCTOU (two concurrent adds of *different*
    // profiles can both read `total = 499` and both insert), which this does
    // not close and is not a regression.
    yield* Effect.tryPromise({
      try: () => db.insert(chatMembers).values(row),
      catch: (cause) =>
        isUniqueConstraintFailure(cause)
          ? new AlreadyMember({ chatId, profileId })
          : new DatabaseError({ cause }),
    });
    metricMemberAdded("ok");

    // Returned from the values just written — see `provisionC2bChat`.
    return row;
  }).pipe(Effect.withSpan("zap.chats.add_member"));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Still used by `removeMember` (admin-removing-another-member path) — not a
// fold target in this plan, only `updateChat` and `addMember` are.
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

export const removeMember = (
  chatId: string,
  profileId: string,
  requestingProfileId: string,
): Effect.Effect<
  void,
  ChatNotFound | NotChatAdmin | NotChatMember | NotC2cChat | LastAdmin | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const chat = yield* getChat(chatId);

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

    // Below every gate, not above them. `assertC2c` answers 409 "not a c2c
    // chat", which to a caller with no standing in the chat would say the id
    // names a commercial conversation — the same disclosure the two public
    // message routes order around. Self-removal has no admin check, so the
    // membership lookup above is the gate on that path, and this has to sit
    // under it to be behind one.
    yield* assertC2c(chat);

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
    const now = storedNow();

    const row: Chat = {
      id,
      type: "group",
      class: "c2b",
      title: validated.title ?? null,
      eventId: null,
      createdByProfileId: validated.createdByProfileId,
      createdAt: now,
      updatedAt: now,
    };

    // Insert all members (no role distinction — cire is the trusted authorizer).
    const memberRows = memberSet.map((profileId) => ({
      id: "cmem_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      chatId: id,
      profileId,
      role: "member" as const,
      joinedAt: now,
    }));

    // FK-first ordering: the chat row is inserted before any member row,
    // which references it. Chunked at MAX_MEMBER_ROWS_PER_INSERT rows per
    // INSERT to stay under D1's ~100-bound-parameter ceiling — up to
    // MAX_CHAT_MEMBERS (500) rows here chunks into ceil(500/20) = 25
    // INSERTs, plus the chat INSERT itself = 26 statements — under D1's
    // 50-queries-per-invocation Free-tier bound. Atomic on D1 (`db.batch`);
    // on bun:sqlite `commitBatch` chains the statements sequentially with
    // no rollback, which is not a regression versus the two separate awaits
    // this replaces — no test may assert joint rollback there.
    yield* Effect.tryPromise({
      try: () =>
        commitBatch(db, [
          db.insert(chats).values(row),
          ...chunkRows(memberRows, MAX_MEMBER_ROWS_PER_INSERT).map((chunk) =>
            db.insert(chatMembers).values(chunk),
          ),
        ]),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Returned from the values just written rather than read back. Every
    // column is known here — nothing is defaulted or computed by the database
    // — so `getChat` was a further round-trip that could only return what we
    // already had, plus a `ChatNotFound` branch that could not happen.
    return row;
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
