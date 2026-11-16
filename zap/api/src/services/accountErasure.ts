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
 * One read, then one batch whose statements each check membership as they
 * run, so a member added between the read and the batch keeps the chat. The
 * ledger row counts the kept messages in the same batch, after the deletes
 * and before the senders are replaced, so the count agrees with what the
 * batch kept. On D1 the batch commits whole, so a batch that fails leaves
 * nothing marked done.
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

/** The kept-message count the ledger holds for `accountId`, or null when it holds none. */
const ledgerOf = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ keptMessages: zapAccountPurges.keptMessages })
          .from(zapAccountPurges)
          .where(eq(zapAccountPurges.accountId, accountId))
          .limit(1),
      catch: (cause) => new ZapErasureDbError({ cause }),
    });
    return row?.keptMessages ?? null;
  });

/**
 * Erases `profileIds`' Zap data for the account `accountId`. A repeat for the
 * same account, or a second call that overlaps the first, writes nothing more
 * and answers what the first one kept.
 */
export const purgeAccount = (
  accountId: string,
  profileIds: ReadonlyArray<string>,
): Effect.Effect<ZapErasureResult, ZapErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const profiles = jsonEachIn(profileIds);

    // One read: the ledger row, if the account was erased before, and the
    // chats the profiles are members of.
    const [state] = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            keptMessages: sql<
              number | null
            >`(SELECT ${zapAccountPurges.keptMessages} FROM ${zapAccountPurges} WHERE ${eq(zapAccountPurges.accountId, accountId)})`,
            chatIds: sql<string>`(SELECT json_group_array(DISTINCT ${chatMembers.chatId}) FROM ${chatMembers} WHERE ${inArray(chatMembers.profileId, profiles)})`,
          })
          .from(sql`(SELECT 1)`),
      catch: (cause) => new ZapErasureDbError({ cause }),
    });
    if (state?.keptMessages !== null && state?.keptMessages !== undefined) {
      metricAccountErased("repeat");
      return { alreadyProcessed: true, kept: keptItems(state.keptMessages) };
    }
    const chatIds = JSON.parse(state?.chatIds ?? "[]") as string[];

    /** No member of the message's (or the chat's) chat but `profileIds`. */
    const noOtherMember = (chatId: typeof messages.chatId | typeof chats.id) =>
      notExists(
        db
          .select({ one: sql`1` })
          .from(otherMember)
          .where(and(eq(otherMember.chatId, chatId), notInArray(otherMember.profileId, profiles))),
      );

    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite).
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
          // The ledger row, with the end-to-end messages the person sent that
          // stayed: counted now, after the deletes and while the messages
          // still name their sender. A second call that overlapped this one
          // finds the row written and writes nothing.
          db
            .insert(zapAccountPurges)
            .select(
              db
                .select({
                  accountId: sql<string>`${accountId}`.as("account_id"),
                  processedAt: sql<number>`${Math.floor(Date.now() / 1_000)}`.as("processed_at"),
                  keptMessages: sql<number>`count(*)`.as("kept_messages"),
                })
                .from(messages)
                .where(
                  and(inArray(messages.senderProfileId, profiles), isNotNull(messages.ciphertext)),
                ),
            )
            .onConflictDoNothing({ target: zapAccountPurges.accountId }),
          // What stays with other members no longer names them.
          db
            .update(messages)
            .set({ senderProfileId: DELETED_SENDER, body: null })
            .where(inArray(messages.senderProfileId, profiles)),
          db
            .update(chats)
            .set({ createdByProfileId: DELETED_SENDER })
            .where(inArray(chats.createdByProfileId, profiles)),
        ]),
      catch: (cause) => new ZapErasureDbError({ cause }),
    }).pipe(Effect.tapError(() => Effect.sync(() => metricAccountErased("error"))));

    // What the ledger holds, as the batch, or an overlapping call, wrote it.
    const keptMessages = yield* ledgerOf(accountId);
    metricAccountErased("ok");
    return { alreadyProcessed: false, kept: keptItems(keptMessages ?? 0) };
  }).pipe(Effect.withSpan("zap.account_erasure.purge"));
