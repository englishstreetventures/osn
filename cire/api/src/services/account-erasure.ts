/**
 * What an OSN account's deletion does in cire, and what it would leave open.
 *
 * osn-api asks every app the same two things over ARC
 * (`osn/api/src/services/deletion-apps.ts`): a preview of what needs the
 * person's answer before they delete, and, once the seven-day window has
 * passed, the erasure itself with their answers. `routes/internal-account-deletion.ts`
 * verifies the calls; this file does the work.
 *
 * **Weddings the person owns.** A wedding never passes to an editor. Where
 * another owner remains, the person's seat goes, with its RSVP notice row, and
 * the wedding stays with that owner. A wedding a profile of the account alone
 * owns is {@link soleOwnedWeddings}' to answer.
 *
 * **Everything else, once per account.** Seats below owner, notice rows,
 * organiser sessions, guest account links, Stripe OAuth states and the
 * profile's budget rows are deleted; every column that names one of the
 * profiles is cleared ({@link DELETED_PROFILE}).
 *
 * **Safe to repeat.** Each wedding the person owns is one D1 batch, at most
 * {@link MAX_OWNED_WEDDINGS_PER_CALL} a call; a call that leaves more answers
 * `not_finished`, and osn-api calls again on its next pass. Every statement is
 * guarded on the state it moves rows out of, so a repeat writes nothing more.
 */
import {
  directoryVendors,
  guestAccountLinks,
  guests,
  hostRsvpNotices,
  organiserSessions,
  ownerNoticeBudget,
  realtimeSubscribeBudget,
  registryClaims,
  registryContributions,
  registrySettings,
  registryStripeOAuthStates,
  rsvpChanges,
  rsvps,
  unlockCodeRedemptions,
  vendorEnquiries,
  weddingHosts,
  weddings,
  weddingUpgradePurchases,
} from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { commitBatchResults, DbService, outerColumn } from "../db";
import { metricAccountDeletionWedding } from "../metrics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * What a column that cannot be NULL holds once the profile it named is erased,
 * and what a nullable one paired with a time that stays holds (a gift's
 * `thanked_by` beside `thanked_at`). Never a real OSN profile id, which starts
 * `usr_`; the same value Zap writes for an erased sender.
 */
export const DELETED_PROFILE = "deleted";

/**
 * Weddings the person owns that one erasure call takes, each its own batch.
 * Counting every statement singly, a call makes at most 1 (the read of owned
 * weddings) + 2 per wedding + 25 (the account's clean-up), inside the 50 D1
 * queries one Worker invocation may make on Workers Free.
 */
export const MAX_OWNED_WEDDINGS_PER_CALL = 3;

/** Weddings with another owner a preview lists one by one; past it, one row counts them. */
const MAX_PREVIEW_INFO_ROWS = 99;

/** Characters of a wedding's name a label quotes: the name's own write-time limit. */
const MAX_NAME_IN_TEXT = 120;

const ACTION_PREFIX = "cire:wedding:";
const ACTION_ALL_CO_OWNED = "cire:weddings:co_owned";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One choice an open action offers, in the contract's field names. */
export interface ActionChoice {
  readonly choice: string;
  readonly description: string;
  /** Unix seconds anything kept is erased, or null. */
  readonly erasedOn: number | null;
}

/** What the account holds that needs, or is shown beside, the person's answer. */
export interface OpenAction {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly choices: ReadonlyArray<ActionChoice>;
  readonly defaultChoice: string | null;
  readonly link: string | null;
}

/** One thing cire keeps after the account is gone, in the contract's field names. */
export interface KeptItem {
  readonly what: string;
  readonly erasedOn: number | null;
  readonly requestUrl: string | null;
}

export type DeletionAnswers = Readonly<Record<string, { readonly choice: string }>>;

export type ErasureResult =
  | { readonly status: "done"; readonly kept: ReadonlyArray<KeptItem> }
  | { readonly status: "not_finished" };

class AccountErasureError extends Data.TaggedError("AccountErasureError")<{
  readonly op: "preview" | "wedding" | "account";
  readonly reason: string;
}> {}

/** The name as a label quotes it, cut to its write-time limit. */
const quoted = (name: string): string =>
  `"${name.length > MAX_NAME_IN_TEXT ? `${name.slice(0, MAX_NAME_IN_TEXT)}…` : name}"`;

/** Every profile of the account, as one bound list. */
const inProfiles = (column: AnySQLiteColumn, profileIds: ReadonlyArray<string>): SQL =>
  inArray(column, jsonEachIn(profileIds));

/** An owner seat on `weddingId` held by none of `profileIds`. */
const otherOwnerOn = (weddingId: SQL | string, profileIds: ReadonlyArray<string>): SQL =>
  sql`EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.role} = 'owner' AND ${weddingHosts.osnProfileId} NOT IN ${jsonEachIn(profileIds)})`;

// ---------------------------------------------------------------------------
// Weddings a profile of the account alone owns
// ---------------------------------------------------------------------------

/**
 * Every live wedding whose owner seats are all the account's: what the
 * preview offers for them and what the erasure does to them. Not decided yet,
 * so both refuse: an account that alone owns a wedding can be neither
 * previewed nor erased here. osn-api reads the refused preview as not checked
 * and holds the deletion, and leaves cire's mark pending at the erasure.
 */
const soleOwnedWeddings = {
  previewActions(
    owned: ReadonlyArray<{ readonly weddingId: string; readonly name: string }>,
  ): Effect.Effect<ReadonlyArray<OpenAction>, AccountErasureError> {
    if (owned.length === 0) return Effect.succeed([]);
    return Effect.fail(new AccountErasureError({ op: "preview", reason: "sole_owner_undecided" }));
  },
  erase(weddingId: string): Effect.Effect<never, AccountErasureError> {
    return Effect.logWarning("account erasure: a wedding the person alone owns waits").pipe(
      Effect.annotateLogs({ weddingId }),
      Effect.andThen(
        Effect.fail(new AccountErasureError({ op: "wedding", reason: "sole_owner_undecided" })),
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * What deleting the account of `profileIds` would leave open in cire: for
 * each live wedding another owner keeps, a row for information. A wedding the
 * person holds only a lower seat on needs no answer: the seat goes and
 * nothing else changes.
 */
function preview(input: {
  readonly profileIds: ReadonlyArray<string>;
  readonly deletesAt: number;
  readonly organiserOrigin: string;
}): Effect.Effect<ReadonlyArray<OpenAction>, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    if (input.profileIds.length === 0) return [];
    const db = yield* DbService;
    const rows = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          db
            .select({
              weddingId: weddings.id,
              name: weddings.displayName,
              coOwned: sql<number>`${otherOwnerOn(outerColumn(weddings.id), input.profileIds)}`,
            })
            .from(weddingHosts)
            .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
            .where(
              and(
                inProfiles(weddingHosts.osnProfileId, input.profileIds),
                eq(weddingHosts.role, "owner"),
                isNull(weddings.deletedAt),
              ),
            )
            .groupBy(weddings.id)
            .orderBy(asc(sql`min(${weddingHosts.createdAt})`), asc(weddings.id))
            .all(),
        ),
      catch: (e) => new AccountErasureError({ op: "preview", reason: String(e) }),
    });

    const sole = yield* soleOwnedWeddings.previewActions(rows.filter((row) => !row.coOwned));
    const coOwned = rows.filter((row) => row.coOwned);
    const infoRows: OpenAction[] =
      coOwned.length > MAX_PREVIEW_INFO_ROWS
        ? [
            {
              id: ACTION_ALL_CO_OWNED,
              kind: "weddings_co_owned",
              label: `${coOwned.length} weddings stay with their other owners.`,
              choices: [],
              defaultChoice: null,
              link: null,
            },
          ]
        : coOwned.map((row) => ({
            id: `${ACTION_PREFIX}${row.weddingId}`,
            kind: "wedding_co_owned",
            label: `${quoted(row.name)} stays with its other owners.`,
            choices: [],
            defaultChoice: null,
            link: null,
          }));
    return [...sole, ...infoRows];
  }).pipe(Effect.withSpan("cire.account_deletion.preview"));
}

// ---------------------------------------------------------------------------
// Erase
// ---------------------------------------------------------------------------

interface EraseInput {
  readonly accountId: string;
  readonly profileIds: ReadonlyArray<string>;
  readonly choices: DeletionAnswers;
  readonly deleteEverything: boolean;
  /** The person's address; nothing cire keeps needs it yet. */
  readonly email: string | null;
  readonly organiserOrigin: string;
  readonly now?: Date;
}

/**
 * One wedding a profile of the account owns beside another owner, in one
 * batch: the profiles' notice rows and seats go, each only while an owner
 * outside the account remains, so a co-owner who left since the call's first
 * read leaves the seat for {@link soleOwnedWeddings}.
 */
function leaveCoOwnedWedding(
  weddingId: string,
  profileIds: ReadonlyArray<string>,
): Effect.Effect<void, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .delete(hostRsvpNotices)
            .where(
              and(
                eq(hostRsvpNotices.weddingId, weddingId),
                inProfiles(hostRsvpNotices.osnProfileId, profileIds),
                otherOwnerOn(weddingId, profileIds),
              ),
            ),
          db
            .delete(weddingHosts)
            .where(
              and(
                eq(weddingHosts.weddingId, weddingId),
                inProfiles(weddingHosts.osnProfileId, profileIds),
                otherOwnerOn(weddingId, profileIds),
              ),
            )
            .returning({ role: weddingHosts.role }),
        ]),
      catch: (e) => new AccountErasureError({ op: "wedding", reason: String(e) }),
    }).pipe(
      Effect.tapError((err) =>
        Effect.logError("account erasure: a wedding's batch failed").pipe(
          Effect.annotateLogs({ weddingId, reason: err.reason }),
        ),
      ),
    );
    if ((results[1] as ReadonlyArray<{ role: string }>).length > 0) {
      metricAccountDeletionWedding("seat_removed");
    }
  }).pipe(Effect.withSpan("cire.account_deletion.wedding", { attributes: { weddingId } }));
}

/** A nullable column cleared where it names one of `profiles`. */
const clearedIn = (column: AnySQLiteColumn, profiles: ReadonlyArray<string>, to: string | null) =>
  sql`CASE WHEN ${inProfiles(column, profiles)} THEN ${to} ELSE ${column} END`;

/**
 * Everything of the account outside the weddings it owns, in one batch: seats
 * below owner and every notice row with no owner seat behind it, organiser
 * sessions, guest account links (by the account or a profile), Stripe OAuth
 * states, the profiles' budget rows, and every column that names a profile,
 * nullable ones to NULL (or {@link DELETED_PROFILE} beside a time that stays,
 * or `''` on the RSVP change log, where NULL means the household's own
 * change), and those that cannot be NULL to {@link DELETED_PROFILE}. An
 * enquiry the person opened that no chat ever took is deleted, which frees the
 * wedding to enquire with that vendor again. Then a count of the owner seats
 * the profiles still hold (one made owner since the call's first read), which
 * the call must take first.
 *
 * Most of these UPDATEs scan their table: the columns are not indexed, and
 * they can name the person on weddings they left long ago. It runs once per
 * account, on the call that finishes.
 */
function eraseAccountRows(input: EraseInput) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const p = input.profileIds;
    const ownerSeatOfRow = sql`EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${outerColumn(hostRsvpNotices.weddingId)} AND ${weddingHosts.osnProfileId} = ${outerColumn(hostRsvpNotices.osnProfileId)} AND ${weddingHosts.role} = 'owner')`;

    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .delete(hostRsvpNotices)
            .where(and(inProfiles(hostRsvpNotices.osnProfileId, p), sql`NOT ${ownerSeatOfRow}`)),
          db
            .delete(weddingHosts)
            .where(and(inProfiles(weddingHosts.osnProfileId, p), ne(weddingHosts.role, "owner"))),
          db.delete(organiserSessions).where(inProfiles(organiserSessions.osnProfileId, p)),
          db
            .delete(guestAccountLinks)
            .where(
              or(
                eq(guestAccountLinks.osnAccountId, input.accountId),
                inProfiles(guestAccountLinks.osnProfileId, p),
              ),
            ),
          db
            .delete(registryStripeOAuthStates)
            .where(inProfiles(registryStripeOAuthStates.osnProfileId, p)),
          db
            .delete(realtimeSubscribeBudget)
            .where(inProfiles(realtimeSubscribeBudget.osnProfileId, p)),
          db
            .delete(ownerNoticeBudget)
            .where(
              inArray(
                ownerNoticeBudget.key,
                sql`(SELECT 'actor:' || value FROM json_each(${JSON.stringify(p)}))`,
              ),
            ),
          db
            .update(weddings)
            .set({
              updatedByOsnProfileId: clearedIn(weddings.updatedByOsnProfileId, p, null),
              deletedByOsnProfileId: clearedIn(weddings.deletedByOsnProfileId, p, null),
            })
            .where(
              or(
                inProfiles(weddings.updatedByOsnProfileId, p),
                inProfiles(weddings.deletedByOsnProfileId, p),
              ),
            ),
          db
            .update(guests)
            .set({ emailAttestedByOsnProfileId: null })
            .where(inProfiles(guests.emailAttestedByOsnProfileId, p)),
          db
            .update(directoryVendors)
            .set({ claimedByProfileId: null })
            .where(inProfiles(directoryVendors.claimedByProfileId, p)),
          db
            .update(directoryVendors)
            .set({ reviewOrgId: null, reviewProfileId: null, reviewRequestedAt: null })
            .where(inProfiles(directoryVendors.reviewProfileId, p)),
          db
            .update(registrySettings)
            .set({ stripeConnectedByOsnProfileId: null })
            .where(inProfiles(registrySettings.stripeConnectedByOsnProfileId, p)),
          db
            .update(registryClaims)
            .set({
              thankedBy: clearedIn(registryClaims.thankedBy, p, DELETED_PROFILE),
              noteHiddenByOsnProfileId: clearedIn(
                registryClaims.noteHiddenByOsnProfileId,
                p,
                DELETED_PROFILE,
              ),
            })
            .where(
              or(
                inProfiles(registryClaims.thankedBy, p),
                inProfiles(registryClaims.noteHiddenByOsnProfileId, p),
              ),
            ),
          db
            .update(registryContributions)
            .set({
              thankedBy: clearedIn(registryContributions.thankedBy, p, DELETED_PROFILE),
              noteHiddenByOsnProfileId: clearedIn(
                registryContributions.noteHiddenByOsnProfileId,
                p,
                DELETED_PROFILE,
              ),
            })
            .where(
              or(
                inProfiles(registryContributions.thankedBy, p),
                inProfiles(registryContributions.noteHiddenByOsnProfileId, p),
              ),
            ),
          db
            .update(rsvps)
            .set({
              recordedByOsnProfileId: clearedIn(rsvps.recordedByOsnProfileId, p, null),
              dietaryAttestedByOsnProfileId: clearedIn(
                rsvps.dietaryAttestedByOsnProfileId,
                p,
                null,
              ),
            })
            .where(
              or(
                inProfiles(rsvps.recordedByOsnProfileId, p),
                inProfiles(rsvps.dietaryAttestedByOsnProfileId, p),
              ),
            ),
          db
            .update(rsvpChanges)
            .set({ actorOsnProfileId: "" })
            .where(inProfiles(rsvpChanges.actorOsnProfileId, p)),
          db
            .update(unlockCodeRedemptions)
            .set({ redeemedByOsnProfileId: null })
            .where(inProfiles(unlockCodeRedemptions.redeemedByOsnProfileId, p)),
          db
            .update(weddingHosts)
            .set({ addedByOsnProfileId: DELETED_PROFILE })
            .where(inProfiles(weddingHosts.addedByOsnProfileId, p)),
          db
            .delete(vendorEnquiries)
            .where(
              and(inProfiles(vendorEnquiries.createdBy, p), isNull(vendorEnquiries.zapChatId)),
            ),
          db
            .update(vendorEnquiries)
            .set({ createdBy: DELETED_PROFILE })
            .where(inProfiles(vendorEnquiries.createdBy, p)),
          db
            .update(weddingUpgradePurchases)
            .set({ createdByOsnProfileId: DELETED_PROFILE })
            .where(inProfiles(weddingUpgradePurchases.createdByOsnProfileId, p)),
          db
            .select({ owned: sql<number>`count(*)` })
            .from(weddingHosts)
            .where(and(inProfiles(weddingHosts.osnProfileId, p), eq(weddingHosts.role, "owner"))),
        ]),
      catch: (e) => new AccountErasureError({ op: "account", reason: String(e) }),
    }).pipe(
      Effect.tapError((err) =>
        Effect.logError("account erasure: the account's clean-up failed").pipe(
          Effect.annotateLogs({ reason: err.reason }),
        ),
      ),
    );
    const [owned] = results[results.length - 1] as ReadonlyArray<{ owned: number }>;
    return { ownerSeatsLeft: Number(owned?.owned ?? 0) };
  }).pipe(Effect.withSpan("cire.account_deletion.cleanup"));
}

/**
 * Erases the account in cire, at the end of its deletion window: each wedding
 * a profile owns ({@link MAX_OWNED_WEDDINGS_PER_CALL} a call, oldest seat
 * first), then, once none is left, everything else of the account. Answers
 * `not_finished` while owned weddings remain or a seat was made owner since
 * the first read; osn-api calls again. Phase 6's "remove my Cire data" calls
 * this too, for a person who keeps their account.
 */
function erase(input: EraseInput): Effect.Effect<ErasureResult, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const owned =
      input.profileIds.length === 0
        ? []
        : yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                db
                  .select({
                    weddingId: weddingHosts.weddingId,
                    coOwned: sql<number>`${otherOwnerOn(outerColumn(weddingHosts.weddingId), input.profileIds)}`,
                  })
                  .from(weddingHosts)
                  .where(
                    and(
                      inProfiles(weddingHosts.osnProfileId, input.profileIds),
                      eq(weddingHosts.role, "owner"),
                    ),
                  )
                  .groupBy(weddingHosts.weddingId)
                  .orderBy(asc(sql`min(${weddingHosts.createdAt})`), asc(weddingHosts.weddingId))
                  .limit(MAX_OWNED_WEDDINGS_PER_CALL + 1)
                  .all(),
              ),
            catch: (e) => new AccountErasureError({ op: "wedding", reason: String(e) }),
          });

    for (const { weddingId, coOwned } of owned.slice(0, MAX_OWNED_WEDDINGS_PER_CALL)) {
      if (coOwned) yield* leaveCoOwnedWedding(weddingId, input.profileIds);
      else yield* soleOwnedWeddings.erase(weddingId);
    }
    if (owned.length > MAX_OWNED_WEDDINGS_PER_CALL) return { status: "not_finished" } as const;

    const { ownerSeatsLeft } = yield* eraseAccountRows(input);
    if (ownerSeatsLeft > 0) return { status: "not_finished" } as const;
    return { status: "done", kept: [] } as const;
  }).pipe(Effect.withSpan("cire.account_deletion.erase"));
}

export const accountErasureService = { preview, erase };
