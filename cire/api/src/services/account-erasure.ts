/**
 * What an OSN account's deletion does in cire, and what it would leave open.
 *
 * osn-api asks every app the same two things over ARC
 * (`osn/api/src/services/deletion-apps.ts`): a preview of what needs the
 * person's answer before they delete, and, once the seven-day window has
 * passed, the erasure itself with their answers. `routes/internal-account-deletion.ts`
 * verifies the calls; this file does the work.
 *
 * **Weddings the person owns.** A wedding never passes to an editor, and
 * never exists without an owner. While a profile of the account is the only
 * owner of a live wedding, the preview lists it as an action with one choice,
 * `delete`, and no default, so osn-api refuses the deletion until the person
 * answers it (or deletes everything), adds another owner, or deletes the
 * wedding in cire. At the erasure, the person's seats go, with their RSVP
 * notice rows; a wedding left with no owner is soft-deleted in the same batch,
 * whatever was answered, so an erasure always finishes and no wedding is left
 * without an owner. The purge takes a deleted wedding with no owner at once.
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
import { archivePageOf, linkOrigin } from "./account-export";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * What a column that cannot be NULL holds once the profile it named is erased,
 * and what a nullable one holds where NULL means something else: beside a
 * time that stays (a gift's `thanked_by` beside `thanked_at`), or where NULL
 * says the guest or household wrote it (`rsvps.recorded_by_osn_profile_id`,
 * the two attestation columns). Never a real OSN profile id, which starts
 * `usr_`; the same value Zap writes for an erased sender.
 */
export const DELETED_PROFILE = "deleted";

/**
 * Weddings the person owns that one erasure call takes, each its own batch.
 * Counting every statement singly, a call makes at most 1 (the read of owned
 * weddings) + 3 per wedding + 21 (the account's clean-up), inside the 50 D1
 * queries one Worker invocation may make on Workers Free.
 */
export const MAX_OWNED_WEDDINGS_PER_CALL = 3;

/** Sole-owned weddings a preview lists one by one; past it, one action stands for all. */
const MAX_PREVIEW_ACTIONS = 100;

/** Characters of a wedding's name a label quotes: the name's own write-time limit. */
const MAX_NAME_IN_TEXT = 120;

const ACTION_PREFIX = "cire:wedding:";
const ACTION_ALL = "cire:weddings:all";

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

export type ErasureResult =
  | { readonly status: "done"; readonly kept: ReadonlyArray<KeptItem> }
  | { readonly status: "not_finished" };

/** What one call did to a wedding a profile of the account owned. */
export interface OwnedOutcome {
  readonly weddingId: string;
  /** `deleted`: no other owner was left; `seat_removed`: another owner keeps it. */
  readonly outcome: "deleted" | "seat_removed";
}

class AccountErasureError extends Data.TaggedError("AccountErasureError")<{
  readonly reason: string;
}> {}

/** The name as a label quotes it, cut to its write-time limit. */
const quoted = (name: string): string =>
  `"${name.length > MAX_NAME_IN_TEXT ? `${name.slice(0, MAX_NAME_IN_TEXT)}…` : name}"`;

/** Every profile of the account, as one bound list. */
const inProfiles = (column: AnySQLiteColumn, profileIds: ReadonlyArray<string>): SQL =>
  inArray(column, jsonEachIn(profileIds));

/**
 * An owner seat on `weddingId` held by none of `profileIds`: the rule both the
 * preview and a host's removal list (`services/account-removal.ts`) read sole
 * ownership by.
 */
export const otherOwnerOn = (weddingId: SQL | string, profileIds: ReadonlyArray<string>): SQL =>
  sql`EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.role} = 'owner' AND ${weddingHosts.osnProfileId} NOT IN ${jsonEachIn(profileIds)})`;

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const DELETE_ONE =
  "Deleted with its guests, replies and invite when your account is deleted. Download its guest list and other exports from Cire first if you want a copy. Any other wedding you are the only owner of by then is deleted too.";
const DELETE_MANY =
  "Deleted with their guests, replies and invites when your account is deleted. Download their guest lists and other exports from Cire first if you want a copy. Any other wedding you are the only owner of by then is deleted too.";

/**
 * What deleting the account of `profileIds` would leave open in cire: one
 * action per live wedding whose owner seats are all the account's, with one
 * choice, `delete`, and no default, so the deletion waits until the person
 * answers it, adds another owner, or deletes the wedding. The action's link
 * opens the wedding's download page in the portal, which offers the download
 * and, beside it, the way to add another owner (the action is then gone).
 * Past {@link MAX_PREVIEW_ACTIONS}, one action, `cire:weddings:all`, stands
 * for them all. A wedding with another owner, or one the person holds a lower
 * seat on, needs no answer: their seat goes and the wedding stays.
 */
function preview(input: {
  readonly profileIds: ReadonlyArray<string>;
  readonly deletesAt: number;
  readonly organiserOrigin: string;
}): Effect.Effect<ReadonlyArray<OpenAction>, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const sole = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          db
            .select({ weddingId: weddings.id, name: weddings.displayName })
            .from(weddingHosts)
            .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
            .where(
              and(
                inProfiles(weddingHosts.osnProfileId, input.profileIds),
                eq(weddingHosts.role, "owner"),
                isNull(weddings.deletedAt),
                sql`NOT ${otherOwnerOn(outerColumn(weddings.id), input.profileIds)}`,
              ),
            )
            .groupBy(weddings.id)
            .orderBy(asc(sql`min(${weddingHosts.createdAt})`), asc(weddings.id))
            .limit(MAX_PREVIEW_ACTIONS + 1)
            .all(),
        ),
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    });

    const origin = linkOrigin(input.organiserOrigin);
    if (sole.length > MAX_PREVIEW_ACTIONS) {
      return [
        {
          id: ACTION_ALL,
          kind: "weddings_sole_owner",
          label: `You are the only owner of more than ${MAX_PREVIEW_ACTIONS} weddings. Add another owner to each you want to keep, or they are deleted when your account is.`,
          choices: [{ choice: "delete", description: DELETE_MANY, erasedOn: null }],
          defaultChoice: null,
          link: origin ? `${origin}/` : null,
        },
      ];
    }
    return sole.map((row) => ({
      id: `${ACTION_PREFIX}${row.weddingId}`,
      kind: "wedding_sole_owner",
      label: `You are the only owner of ${quoted(row.name)}. Add another owner in Cire to keep it, or it is deleted when your account is.`,
      choices: [{ choice: "delete", description: DELETE_ONE, erasedOn: null }],
      defaultChoice: null,
      link: origin ? archivePageOf(origin, row.weddingId) : null,
    }));
  }).pipe(Effect.withSpan("cire.account_deletion.preview"));
}

// ---------------------------------------------------------------------------
// Erase
// ---------------------------------------------------------------------------

/**
 * The account and its profiles. The person's answers are not an input: the
 * one answer cire offers is `delete`, and a wedding left with no owner is
 * deleted whatever was answered.
 */
interface EraseInput {
  readonly accountId: string;
  readonly profileIds: ReadonlyArray<string>;
  readonly now?: Date;
  /**
   * `account` (the default): the account is being deleted, and everything
   * cire holds of it goes. `host`: the person is leaving cire as a host and
   * keeping the account, so their vendor listing claims and their guest
   * account links stay; seats, weddings, sessions and the rest go as for an
   * account.
   */
  readonly scope?: "account" | "host";
}

/**
 * One wedding a profile of the account owns, in one batch: the wedding is
 * soft-deleted, with no one named as its deleter, only if no owner outside
 * the account's profiles holds a seat; then the profiles' notice rows and
 * seats go. The delete and the seats commit together on D1, and the delete
 * comes first so that a driver running the statements one at a time still
 * never leaves a live wedding without an owner. A wedding already deleted
 * only loses the seats. Each statement is guarded, so a repeat changes
 * nothing.
 */
function eraseOwnedWedding(
  weddingId: string,
  profileIds: ReadonlyArray<string>,
  now: Date,
): Effect.Effect<OwnedOutcome | null, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .update(weddings)
            .set({ deletedAt: now, deletedByOsnProfileId: null })
            .where(
              and(
                eq(weddings.id, weddingId),
                isNull(weddings.deletedAt),
                sql`NOT ${otherOwnerOn(weddingId, profileIds)}`,
              ),
            )
            .returning({ id: weddings.id }),
          db
            .delete(hostRsvpNotices)
            .where(
              and(
                eq(hostRsvpNotices.weddingId, weddingId),
                inProfiles(hostRsvpNotices.osnProfileId, profileIds),
              ),
            ),
          db
            .delete(weddingHosts)
            .where(
              and(
                eq(weddingHosts.weddingId, weddingId),
                inProfiles(weddingHosts.osnProfileId, profileIds),
              ),
            )
            .returning({ role: weddingHosts.role }),
        ]),
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    }).pipe(
      Effect.tapError((err) =>
        Effect.logError("account erasure: a wedding's batch failed").pipe(
          Effect.annotateLogs({ weddingId, reason: err.reason }),
        ),
      ),
    );
    const deleted = (results[0] as ReadonlyArray<{ id: string }>).length > 0;
    const removed = (results[2] as ReadonlyArray<{ role: string }>).length > 0;
    if (!removed) return null;
    const outcome = deleted ? "deleted" : "seat_removed";
    metricAccountDeletionWedding(outcome);
    yield* Effect.logInfo("account erasure: a wedding the person owned").pipe(
      Effect.annotateLogs({ weddingId, outcome }),
    );
    return { weddingId, outcome } as const;
  }).pipe(Effect.withSpan("cire.account_deletion.wedding", { attributes: { weddingId } }));
}

/** A nullable column cleared where it names one of `profiles`. */
const clearedIn = (column: AnySQLiteColumn, profiles: ReadonlyArray<string>, to: string | null) =>
  sql`CASE WHEN ${inProfiles(column, profiles)} THEN ${to} ELSE ${column} END`;

/**
 * Everything of the account outside the weddings it owns, in one batch: seats
 * below owner and every notice row with no owner seat behind it, organiser
 * sessions, guest account links (by the account or a profile; not for the
 * `host` scope), Stripe OAuth states, the profiles' budget rows, and every
 * column that names a profile (a vendor listing's claim columns not for the
 * `host` scope),
 * nullable ones to NULL (or {@link DELETED_PROFILE} where NULL means
 * something else, or `''` on the RSVP change log, where NULL means the
 * household's own change), and those that cannot be NULL to
 * {@link DELETED_PROFILE}. An
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
    const host = input.scope === "host";
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
          // A guest's link to their account: guest data, not the host's, so a
          // host leaving cire keeps it.
          ...(host
            ? []
            : [
                db
                  .delete(guestAccountLinks)
                  .where(
                    or(
                      eq(guestAccountLinks.osnAccountId, input.accountId),
                      inProfiles(guestAccountLinks.osnProfileId, p),
                    ),
                  ),
              ]),
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
            .set({ emailAttestedByOsnProfileId: DELETED_PROFILE })
            .where(inProfiles(guests.emailAttestedByOsnProfileId, p)),
          // A claim the person was waiting on is cleared whole. A vendor
          // listing is the vendor side's, so a host leaving cire keeps it.
          ...(host
            ? []
            : [
                db
                  .update(directoryVendors)
                  .set({
                    claimedByProfileId: clearedIn(directoryVendors.claimedByProfileId, p, null),
                    reviewOrgId: sql`CASE WHEN ${inProfiles(directoryVendors.reviewProfileId, p)} THEN NULL ELSE ${directoryVendors.reviewOrgId} END`,
                    reviewRequestedAt: sql`CASE WHEN ${inProfiles(directoryVendors.reviewProfileId, p)} THEN NULL ELSE ${directoryVendors.reviewRequestedAt} END`,
                    reviewProfileId: clearedIn(directoryVendors.reviewProfileId, p, null),
                  })
                  .where(
                    or(
                      inProfiles(directoryVendors.claimedByProfileId, p),
                      inProfiles(directoryVendors.reviewProfileId, p),
                    ),
                  ),
              ]),
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
              recordedByOsnProfileId: clearedIn(rsvps.recordedByOsnProfileId, p, DELETED_PROFILE),
              dietaryAttestedByOsnProfileId: clearedIn(
                rsvps.dietaryAttestedByOsnProfileId,
                p,
                DELETED_PROFILE,
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
      catch: (e) => new AccountErasureError({ reason: String(e) }),
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
 * Erases the account in cire, at the end of its deletion window or when the
 * person leaves cire as a host (`scope`): each wedding a profile owns
 * ({@link MAX_OWNED_WEDDINGS_PER_CALL} a call, oldest seat first; deleted when
 * no other owner is left), then, once none is left, everything else of the
 * account. cire keeps nothing about the person as a host, so a finished call
 * answers no kept item. Answers `not_finished` while owned weddings remain or
 * a seat was made owner since the first read; the caller calls again. Beside
 * the result, what the call did to each wedding the person owned, for the
 * notices a removal sends.
 */
function eraseWithOutcomes(
  input: EraseInput,
): Effect.Effect<
  { readonly result: ErasureResult; readonly owned: ReadonlyArray<OwnedOutcome> },
  AccountErasureError,
  DbService
> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const owned = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          db
            .select({ weddingId: weddingHosts.weddingId })
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
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    });

    const now = input.now ?? new Date();
    const outcomes: OwnedOutcome[] = [];
    for (const { weddingId } of owned.slice(0, MAX_OWNED_WEDDINGS_PER_CALL)) {
      const outcome = yield* eraseOwnedWedding(weddingId, input.profileIds, now);
      if (outcome) outcomes.push(outcome);
    }
    const notFinished = { result: { status: "not_finished" } as const, owned: outcomes };
    if (owned.length > MAX_OWNED_WEDDINGS_PER_CALL) return notFinished;

    const { ownerSeatsLeft } = yield* eraseAccountRows(input);
    if (ownerSeatsLeft > 0) return notFinished;
    return { result: { status: "done", kept: [] } as const, owned: outcomes };
  }).pipe(
    Effect.withSpan("cire.account_deletion.erase", {
      attributes: { scope: input.scope ?? "account" },
    }),
  );
}

/** {@link eraseWithOutcomes}, its result alone: what osn-api's erasure call answers from. */
function erase(input: EraseInput): Effect.Effect<ErasureResult, AccountErasureError, DbService> {
  return eraseWithOutcomes(input).pipe(Effect.map(({ result }) => result));
}

export const accountErasureService = { preview, erase, eraseWithOutcomes };
