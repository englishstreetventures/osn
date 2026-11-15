import { commitBatch, jsonEachIn } from "@shared/db-utils";
/**
 * What deleting an OSN account does to the person's Zap data, when osn-api's
 * deletion fan-out reaches Zap at the end of the account's 7-day window.
 *
 * Zap holds nothing that needs the person's answer, so its preview lists no
 * action. The erasure, for every profile of the account:
 *
 * - deletes each chat in which the profiles are the only members left, with
 *   its messages;
 * - removes their memberships of every other chat;
 * - in the messages they sent that stay with other members, replaces the
 *   sender with {@link DELETED_SENDER} and wipes the body of a plain-text
 *   (consumer-to-business) message; an end-to-end message keeps its
 *   ciphertext, which Zap cannot read and the other members still hold;
 * - replaces them as the creator of every chat that stays.
 *
 * One read, then one batch whose statements each check membership as they run,
 * the ledger row last, so a member added between the read and the batch keeps
 * the chat, and a batch that fails leaves nothing marked done.
 */
import { chatMembers, chats, messages, zapAccountPurges } from "@zap/db/schema";
import { Db } from "@zap/db/service";
import { and, eq, inArray, isNotNull, notExists, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { metricAccountErased } from "../metrics";

/** The sender a message keeps once its author's account is erased; never a profile id. */
export const DELETED_SENDER = "deleted";

export class ZapErasureDbError extends Data.TaggedError("ZapErasureDbError")<{
  readonly cause: unknown;
}> {}

/** One thing Zap keeps after the account is gone, in the contract's field names. */
export interface KeptItem {
  readonly what: string;
  readonly erasedOn: number | null;
  readonly requestUrl: string | null;
}

/** What an erasure answers osn-api. */
export interface ZapErasureResult {
  readonly alreadyProcessed: boolean;
  readonly kept: ReadonlyArray<KeptItem>;
}

/**
 * The end-to-end messages that stay, as one item: Zap keeps no date for them
 * (they last as long as their chat) and offers no page to ask about them.
 */
const keptItems = (keptMessages: number): ReadonlyArray<KeptItem> =>
  keptMessages > 0
    ? [
        {
          what: "Encrypted messages you sent in chats that still have other members, without your name",
          erasedOn: null,
          requestUrl: null,
        },
      ]
    : [];

const otherMember = alias(chatMembers, "other_member");

/**
 * Erases `profileIds`' Zap data for the account `accountId`. A repeat for the
 * same account writes nothing and answers what the first one kept.
 */
export const purgeAccount = (
  accountId: string,
  profileIds: ReadonlyArray<string>,
): Effect.Effect<ZapErasureResult, ZapErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const profiles = jsonEachIn(profileIds);

    const [done] = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ keptMessages: zapAccountPurges.keptMessages })
          .from(zapAccountPurges)
          .where(eq(zapAccountPurges.accountId, accountId))
          .limit(1),
      catch: (cause) => new ZapErasureDbError({ cause }),
    });
    if (done) {
      metricAccountErased("repeat");
      return { alreadyProcessed: true, kept: keptItems(done.keptMessages) };
    }

    /** No member of the message's (or the chat's) chat but `profileIds`. */
    const noOtherMember = (chatId: typeof messages.chatId | typeof chats.id) =>
      notExists(
        db
          .select({ one: sql`1` })
          .from(otherMember)
          .where(and(eq(otherMember.chatId, chatId), notInArray(otherMember.profileId, profiles))),
      );

    const [memberOf, [kept]] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () =>
            db
              .selectDistinct({ chatId: chatMembers.chatId })
              .from(chatMembers)
              .where(inArray(chatMembers.profileId, profiles)),
          catch: (cause) => new ZapErasureDbError({ cause }),
        }),
        Effect.tryPromise({
          try: () =>
            db
              .select({ count: sql<number>`count(*)` })
              .from(messages)
              .where(
                and(
                  inArray(messages.senderProfileId, profiles),
                  isNotNull(messages.ciphertext),
                  sql`NOT ${noOtherMember(messages.chatId)}`,
                ),
              ),
          catch: (cause) => new ZapErasureDbError({ cause }),
        }),
      ],
      { concurrency: "unbounded" },
    );
    const chatIds = memberOf.map((row) => row.chatId);
    const keptMessages = kept?.count ?? 0;

    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite), the ledger row last.
      try: () =>
        commitBatch(db, [
          // Chats the profiles leave empty go, messages first (each names its
          // chat), then the memberships, then the chats.
          ...(chatIds.length > 0
            ? [
                db
                  .delete(messages)
                  .where(
                    and(
                      inArray(messages.chatId, jsonEachIn(chatIds)),
                      noOtherMember(messages.chatId),
                    ),
                  ),
              ]
            : []),
          db.delete(chatMembers).where(inArray(chatMembers.profileId, profiles)),
          ...(chatIds.length > 0
            ? [
                db.delete(chats).where(
                  and(
                    inArray(chats.id, jsonEachIn(chatIds)),
                    notExists(
                      db
                        .select({ one: sql`1` })
                        .from(chatMembers)
                        .where(eq(chatMembers.chatId, chats.id)),
                    ),
                  ),
                ),
              ]
            : []),
          // What stays with other members no longer names them.
          db
            .update(messages)
            .set({ senderProfileId: DELETED_SENDER, body: null })
            .where(inArray(messages.senderProfileId, profiles)),
          db
            .update(chats)
            .set({ createdByProfileId: DELETED_SENDER })
            .where(inArray(chats.createdByProfileId, profiles)),
          db.insert(zapAccountPurges).values({
            accountId,
            processedAt: Math.floor(Date.now() / 1_000),
            keptMessages,
          }),
        ]),
      catch: (cause) => new ZapErasureDbError({ cause }),
    }).pipe(Effect.tapError(() => Effect.sync(() => metricAccountErased("error"))));

    metricAccountErased("ok");
    return { alreadyProcessed: false, kept: keptItems(keptMessages) };
  }).pipe(Effect.withSpan("zap.account_erasure.purge"));
