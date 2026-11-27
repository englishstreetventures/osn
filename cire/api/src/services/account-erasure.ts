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
 * without an owner. The purge takes a deleted wedding with no owner at once,
 * unless it holds it ({@link purgeHeld}).
 *
 * **Everything else, once per account.** Seats below owner, notice rows,
 * guest account links, Stripe OAuth states and the profile's budget rows are
 * deleted; every column that names one of the profiles is cleared
 * ({@link DELETED_PROFILE}). Organiser sessions end before the weddings, on
 * every call, for an account's erasure; for a host's removal, in this
 * clean-up once no seat of theirs is left.
 *
 * **What it answers it keeps.** The soft delete names the profile whose owner
 * seat it took as the wedding's deleter, so the call that finishes can find
 * the weddings every call of the erasure deleted. That call counts those the
 * purge still holds, answers them as one kept item ({@link keptItems}), and
 * clears the deleter with every other column that names the person: once it
 * answers done, no record names them. "Remove my Cire data" (the `host`
 * scope) clears the deleter the same way and counts nothing, since its route
 * answers no kept item. Three limits follow. A repeat after osn-api lost that
 * answer reports nothing kept. A wedding someone else deleted and then left
 * to the person alone names no profile of theirs, so it is not counted; nor
 * is one an earlier "Remove my Cire data" deleted.
 *
 * **A payout account's holder, deleting their account.** Where a profile of
 * the account holds the Stripe account a live wedding's money gifts are paid
 * into, beside another owner ({@link payoutHeldSeat}), the account deletion's
 * preview ({@link deletionPreview}) shows one action with a default, `close`,
 * which never blocks. The erasure takes the seat, so the account's holder is
 * gone and money gifts close; the remaining owners are told by email, through
 * a hook only its caller passes (`onPayoutHolderLeft`), as each wedding's batch
 * commits. The service never mails on its own: a repeated call removes no
 * seat, so it mails no one, and a caller that passes no hook mails no one,
 * which is how a replay of recorded erasures after a database restore must
 * call it (englishstreetventures/osn#2541). After a restore of both osn-api's
 * and cire's databases, osn-api's next deletion sweep calls the route again,
 * hook and all, and mails the remaining owners once more unless their
 * wedding's seats are already gone.
 *
 * **A payout account's holder, removing their Cire data.** The `host` scope
 * keeps an owner seat whose profile holds the Stripe account the wedding's
 * money gifts are paid into, beside another owner ({@link payoutHeldSeat}):
 * its route refuses such a removal before it calls, and the wedding's own
 * batch keeps the seat for an account connected in between, then the call
 * stops before the account's clean-up. An account's erasure takes the seat.
 *
 * **Safe to repeat.** Each wedding the person owns is one D1 batch, at most
 * {@link MAX_OWNED_WEDDINGS_PER_CALL} a call, and the account's clean-up takes
 * at most {@link MAX_LOWER_SEATS_PER_CALL} seats below owner; a call that
 * leaves more answers `not_finished`, and osn-api calls again on its next pass. Every statement is
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
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { commitBatchResults, DbService, outerColumn } from "../db";
import type { Db } from "../db";
import { epochSeconds } from "../db/live-wedding";
import { metricAccountDeletionWedding } from "../metrics";
import { archivePageOf, linkOrigin } from "./account-export";
import { noOwnerLeft, purgeHeld } from "./maintenance-sweeps";
import { holdsPayoutAccountSql } from "./payout-holder";

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
 * weddings) + 1 (ending the person's organiser sessions) + 3 per wedding + 21
 * (the account's clean-up), inside the 50 D1 queries one Worker invocation may
 * make on Workers Free; a host's removal, 1 + 3 per wedding + 19.
 */
export const MAX_OWNED_WEDDINGS_PER_CALL = 3;

/**
 * Seats below owner the account's clean-up takes in one call, so that every
 * seat a call removes fits its deletion record: with at most one seat per
 * profile on a wedding, a call removes at most
 * `MAX_OWNED_WEDDINGS_PER_CALL × profiles + MAX_LOWER_SEATS_PER_CALL` seats.
 * A call that leaves more answers `not_finished`.
 */
export const MAX_LOWER_SEATS_PER_CALL = 200;

/** Sole-owned weddings a preview lists one by one; past it, one action stands for all. */
const MAX_PREVIEW_ACTIONS = 100;

/**
 * Weddings whose payout account a profile of the account holds, beside another
 * owner, that a deletion preview lists one by one; past it, one action stands
 * for the rest. With {@link MAX_PREVIEW_ACTIONS} sole-owner actions, an answer
 * holds at most 100 + 21, inside osn-api's 200 from one app.
 */
const MAX_PAYOUT_ACTIONS = 20;

/** Characters of a wedding's name a label quotes: the name's own write-time limit. */
const MAX_NAME_IN_TEXT = 120;

const ACTION_PREFIX = "cire:wedding:";
const ACTION_ALL = "cire:weddings:all";
const PAYOUT_PREFIX = "cire:payout:";
const PAYOUT_REST = "cire:payouts:rest";

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

/**
 * What cire keeps once the erasure is done: the deleted weddings the purge
 * still holds, as one item however many there are, so the answer stays inside
 * the contract's 100 items. The words name no wedding, since a wedding's name
 * usually names the couple, so another person, and the answer is stored by
 * osn-api as well as mailed. No date: the purge runs once a day, takes a few
 * weddings a run, and a pending gift can become a dispute, which holds with no
 * end. No link: cire-api knows no address of the hosts' privacy notice.
 */
const keptItems = (heldWeddings: number): ReadonlyArray<KeptItem> => {
  if (heldWeddings <= 0) return [];
  const what =
    heldWeddings === 1
      ? "A deleted wedding you owned, kept until a payment or gift for it settles, then erased in Cire's daily clean-up."
      : `${heldWeddings} deleted weddings you owned, each kept until a payment or gift for it settles, then erased in Cire's daily clean-up.`;
  return [{ what, erasedOn: null, requestUrl: null }];
};

/** What one call did to a wedding a profile of the account owned. */
export interface OwnedOutcome {
  readonly weddingId: string;
  /**
   * `deleted`: this call deleted it, no other owner being left;
   * `seat_removed`: this call did not delete it — another owner keeps it, or
   * it was deleted already and stays so.
   */
  readonly outcome: "deleted" | "seat_removed";
  /**
   * The account's profiles whose owner seat on it went: the only profiles a
   * notice to its other owners may name, since naming another would tell
   * them two profiles are one person.
   */
  readonly leavers: ReadonlyArray<string>;
  /**
   * The batch took the owner seat of the profile holding the Stripe account
   * the wedding's money gifts are paid into, and the wedding is still live
   * after it, so another owner remains.
   */
  readonly payoutHolderLeft: boolean;
  /**
   * Every profile of the account whose seat on it this call removed, owner or
   * below: what a replay of the call's deletion record takes there, and no
   * other seat. A seat the holder rule kept is not among them.
   */
  readonly seatHolders: ReadonlyArray<string>;
}

class AccountErasureError extends Data.TaggedError("AccountErasureError")<{
  readonly reason: string;
}> {}

/**
 * What a call of {@link eraseWithOutcomes} has done so far, filled in only
 * from the answers of batches that answered: what each statement's
 * `RETURNING` confirmed. Each wedding's batch and the clean-up commit on their
 * own, so a caller whose call failed part way reads here what stands, and
 * which batch it had sent without an answer: that one is in doubt, and the
 * deletion record leaves it to a person. It stays with the caller and never
 * rides on the error, so no id reaches a span or a log line through the
 * failure.
 */
export interface ErasureProgress {
  /** Each wedding the person owned whose batch answered and took a seat of the account or deleted it. */
  readonly owned: OwnedOutcome[];
  /** Each seat below owner the account's clean-up removed. */
  readonly lowerSeats: { readonly weddingId: string; readonly profileId: string }[];
  /** The batch sent and not yet answered: a wedding's, the clean-up's, or none. */
  writing: { readonly weddingId: string } | "clean_up" | null;
  /** The account's clean-up batch answered. */
  cleanedUp: boolean;
}

export const erasureProgress = (): ErasureProgress => ({
  owned: [],
  lowerSeats: [],
  writing: null,
  cleanedUp: false,
});

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

/**
 * `profile`, one of `profileIds`, holds the Stripe account money gifts on the
 * live `weddingId` are paid into, and an owner outside the account's profiles
 * remains there: the seat a host's removal of their Cire data must not take
 * while they sit on it as an owner (the hosts writes refuse the same seat,
 * `services/hosts.ts`). A wedding the account alone owns is deleted with the
 * removal, its account with it, so it holds nothing back. The removal's route
 * refuses on it, the preview marks it, and the removal's own writes keep the
 * seat it names. An account's erasure takes the seat regardless.
 */
export const payoutHeldSeat = (
  weddingId: SQL | string,
  profile: SQL,
  profileIds: ReadonlyArray<string>,
): SQL =>
  sql`(${holdsPayoutAccountSql(sql`${weddingId}`, profile)} AND ${otherOwnerOn(weddingId, profileIds)} AND EXISTS (SELECT 1 FROM ${weddings} held_wedding WHERE held_wedding.id = ${weddingId} AND held_wedding.deleted_at IS NULL))`;

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const DELETE_ONE =
  "Deleted with its guests, replies and invite when your account is deleted. Download its guest list and other exports from Cire first if you want a copy. Any other wedding you are the only owner of by then is deleted too.";
const DELETE_MANY =
  "Deleted with their guests, replies and invites when your account is deleted. Download their guest lists and other exports from Cire first if you want a copy. Any other wedding you are the only owner of by then is deleted too.";

/** What both previews take. */
interface PreviewInput {
  readonly profileIds: ReadonlyArray<string>;
  readonly deletesAt: number;
  readonly organiserOrigin: string;
}

/** A live wedding whose owner seats are all the account's: the sole-owner read. */
const soleOwnedQuery = (db: Db, profileIds: ReadonlyArray<string>) =>
  db
    .select({ weddingId: weddings.id, name: weddings.displayName })
    .from(weddingHosts)
    .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
    .where(
      and(
        inProfiles(weddingHosts.osnProfileId, profileIds),
        eq(weddingHosts.role, "owner"),
        isNull(weddings.deletedAt),
        sql`NOT ${otherOwnerOn(outerColumn(weddings.id), profileIds)}`,
      ),
    )
    .groupBy(weddings.id)
    .orderBy(asc(sql`min(${weddingHosts.createdAt})`), asc(weddings.id))
    .limit(MAX_PREVIEW_ACTIONS + 1);

/**
 * A live wedding where a profile of the account holds, from an owner seat, the
 * Stripe account money gifts are paid into, and another owner remains: the
 * rule a host's removal refuses on ({@link payoutHeldSeat}). With the account's
 * type, for the Express line.
 */
const payoutHeldQuery = (db: Db, profileIds: ReadonlyArray<string>) =>
  db
    .select({
      weddingId: weddings.id,
      name: weddings.displayName,
      accountType: registrySettings.stripeAccountType,
    })
    .from(weddingHosts)
    .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
    .innerJoin(registrySettings, eq(registrySettings.weddingId, weddings.id))
    .where(
      and(
        inProfiles(weddingHosts.osnProfileId, profileIds),
        eq(weddingHosts.role, "owner"),
        payoutHeldSeat(
          outerColumn(weddings.id),
          outerColumn(weddingHosts.osnProfileId),
          profileIds,
        ),
      ),
    )
    .groupBy(weddings.id)
    .orderBy(asc(sql`min(${weddingHosts.createdAt})`), asc(weddings.id))
    .limit(MAX_PAYOUT_ACTIONS + 1);

/** The sole-owner actions, or past {@link MAX_PREVIEW_ACTIONS} the one for them all. */
function soleOwnerActions(
  sole: ReadonlyArray<{ weddingId: string; name: string }>,
  origin: string | null,
): ReadonlyArray<OpenAction> {
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
}

/** The wedding's Money gifts, in its registry's Settings tab. */
const moneyGiftsPageOf = (origin: string, weddingId: string): string =>
  `${origin}/#/w/${encodeURIComponent(weddingId)}/registry/settings`;

const PAYOUT_ONE =
  "Guests cannot give money on this wedding until another owner connects an account, and its other owners are told by email. The wedding and its other owners stay. Gifts already given, and any refund or dispute on them, stay with your Stripe account.";
const PAYOUT_EXPRESS =
  " Cire made that account for you, in your name: sign in at connect.stripe.com/express_login to see its payouts, refunds and disputes.";
const PAYOUT_MANY =
  "Guests cannot give money on those weddings until another owner connects an account, and their other owners are told by email. The weddings and their other owners stay. Gifts already given, and any refund or dispute on them, stay with your Stripe account. Any account Cire made for you is in your name: sign in at connect.stripe.com/express_login to see its payouts, refunds and disputes.";

/**
 * A wedding's name as a payout line quotes it, with no mark a mail client
 * turns into a link (`x.com`, `https://…`, `a@b`): another owner can rewrite
 * the name, and osn-api prints the line in its plain-text email to the person.
 */
const linkFree = (name: string): string =>
  name
    .replaceAll(/[.:/@\\]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

/**
 * One action per held wedding ({@link payoutHeldQuery}), with one choice,
 * `close`, as its default, so it never blocks the deletion: the erasure takes
 * the holder's seat whatever was answered, and money gifts close until another
 * owner connects an account. The Express line only for an account cire created
 * (type `express`, or NULL, which reads as Express). The link opens the
 * wedding's Money gifts, where the holder can hand over first. Past
 * {@link MAX_PAYOUT_ACTIONS}, one action stands for the rest.
 */
function payoutActions(
  held: ReadonlyArray<{
    weddingId: string;
    name: string;
    accountType: "express" | "standard" | null;
  }>,
  origin: string | null,
): ReadonlyArray<OpenAction> {
  const actions: OpenAction[] = held.slice(0, MAX_PAYOUT_ACTIONS).map((row) => ({
    id: `${PAYOUT_PREFIX}${row.weddingId}`,
    kind: "wedding_payout_account",
    label: `You connected the Stripe account for money gifts on ${quoted(linkFree(row.name))}. Hand money gifts to another owner in Cire to keep them open, or they close when your account is deleted.`,
    choices: [
      {
        choice: "close",
        description: row.accountType === "standard" ? PAYOUT_ONE : PAYOUT_ONE + PAYOUT_EXPRESS,
        erasedOn: null,
      },
    ],
    defaultChoice: "close",
    link: origin ? moneyGiftsPageOf(origin, row.weddingId) : null,
  }));
  if (held.length > MAX_PAYOUT_ACTIONS) {
    actions.push({
      id: PAYOUT_REST,
      kind: "weddings_payout_account",
      label: `You also connected the Stripe account for money gifts on other weddings that have another owner, beyond the ${MAX_PAYOUT_ACTIONS} above. Hand money gifts to another owner on each in Cire to keep them open, or they close when your account is deleted.`,
      choices: [{ choice: "close", description: PAYOUT_MANY, erasedOn: null }],
      defaultChoice: "close",
      link: origin ? `${origin}/` : null,
    });
  }
  return actions;
}

/**
 * The live weddings whose owner seats are all `profileIds`', as "Remove my
 * Cire data" refuses on them (`routes/organiser-account.ts`): one action per
 * wedding, with one choice, `delete`, and no default, so the removal waits
 * until the person answers it, adds another owner, or deletes the wedding. The
 * action's link opens the wedding's download page in the portal, which offers
 * the download and, beside it, the way to add another owner (the action is
 * then gone). Past {@link MAX_PREVIEW_ACTIONS}, one action, `cire:weddings:all`,
 * stands for them all. A wedding with another owner, or one the person holds a
 * lower seat on, needs no answer: their seat goes and the wedding stays. No
 * payout action: the removal refuses a holder on its own, and reads any action
 * that is not a wedding's as the one standing for them all.
 */
function preview(
  input: PreviewInput,
): Effect.Effect<ReadonlyArray<OpenAction>, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const sole = yield* Effect.tryPromise({
      try: () => Promise.resolve(soleOwnedQuery(db, input.profileIds).all()),
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    });
    return soleOwnerActions(sole, linkOrigin(input.organiserOrigin));
  }).pipe(Effect.withSpan("cire.account_deletion.preview"));
}

/**
 * What deleting the account of `profileIds` would leave open in cire, as
 * osn-api's preview asks: the sole-owner actions of {@link preview}, which the
 * deletion waits on, then the {@link payoutActions}, which it does not. Both
 * lists in one batch, one round trip. The early answer for more than
 * {@link MAX_PREVIEW_ACTIONS} sole-owner weddings keeps the payout actions.
 */
function deletionPreview(
  input: PreviewInput,
): Effect.Effect<ReadonlyArray<OpenAction>, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [sole, held] = yield* Effect.tryPromise({
      try: async () => {
        const [soleRead, heldRead] = await commitBatchResults(db, [
          soleOwnedQuery(db, input.profileIds),
          payoutHeldQuery(db, input.profileIds),
        ]);
        return [
          soleRead as ReadonlyArray<{ weddingId: string; name: string }>,
          heldRead as ReadonlyArray<{
            weddingId: string;
            name: string;
            accountType: "express" | "standard" | null;
          }>,
        ] as const;
      },
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    });
    const origin = linkOrigin(input.organiserOrigin);
    const payout = payoutActions(held, origin);
    yield* Effect.annotateCurrentSpan({ payoutActions: payout.length });
    return [...soleOwnerActions(sole, origin), ...payout];
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
  /**
   * Called as each wedding's batch commits, when it took the owner seat of the
   * profile holding that wedding's payout account and another owner remains
   * ({@link OwnedOutcome.payoutHolderLeft}): the internal route's notice to the
   * remaining owners. Absent, nothing is sent, as a replay of recorded
   * erasures after a database restore must call it
   * (englishstreetventures/osn#2541).
   */
  readonly onPayoutHolderLeft?: (weddingId: string) => Effect.Effect<void>;
}

/**
 * One wedding a profile of the account owns, in one batch: the wedding is
 * soft-deleted only if no owner outside the account's profiles holds a seat,
 * naming as its deleter the profile whose owner seat it is, which the call
 * that finishes reads and then clears (see the module comment); then the
 * profiles' notice rows and seats go. The delete and the seats commit
 * together on D1, and the delete comes first so that a driver running the
 * statements one at a time still never leaves a live wedding without an
 * owner. A wedding already deleted only loses the seats. Each statement is
 * guarded, so a repeat changes nothing.
 *
 * Only the seats the call's first read found go (`seats`, by id), with their
 * profiles' notice rows: a seat added since is left for the account's
 * clean-up (below owner) or the next call (an owner seat, which the
 * clean-up's count reports), each of which records the seats it takes.
 *
 * With `keepHeldSeat` (a host's removal), an owner seat whose profile holds
 * the wedding's payout account ({@link payoutHeldSeat}) stays, with its notice
 * row, under a guard in both deletes. The caller tells it stayed from the
 * seats the batch returns, against the owner seats its first read found.
 */
function eraseOwnedWedding(
  weddingId: string,
  seats: ReadonlyArray<FirstReadSeat>,
  profileIds: ReadonlyArray<string>,
  now: Date,
  keepHeldSeat: boolean,
): Effect.Effect<OwnedOutcome | null, AccountErasureError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const seatIds = seats.map((seat) => seat.id);
    // One seat per profile on a wedding, so these are the first read's seats'
    // profiles: their notice rows go with those seats and no other.
    const seatProfiles = seats.map((seat) => seat.profileId);
    // An owner seat of `profile` here that the holder rule keeps.
    const heldSeatOf = (profile: SQL) =>
      sql`EXISTS (SELECT 1 FROM ${weddingHosts} held_seat WHERE held_seat.wedding_id = ${weddingId} AND held_seat.osn_profile_id = ${profile} AND held_seat.role = 'owner' AND ${payoutHeldSeat(weddingId, profile, profileIds)})`;
    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .update(weddings)
            .set({
              deletedAt: now,
              deletedByOsnProfileId: sql`(SELECT ${weddingHosts.osnProfileId} FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.role} = 'owner' AND ${inProfiles(weddingHosts.osnProfileId, profileIds)} ORDER BY ${weddingHosts.createdAt}, ${weddingHosts.id} LIMIT 1)`,
            })
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
                inProfiles(hostRsvpNotices.osnProfileId, seatProfiles),
                keepHeldSeat
                  ? sql`NOT ${heldSeatOf(outerColumn(hostRsvpNotices.osnProfileId))}`
                  : undefined,
              ),
            ),
          db
            .delete(weddingHosts)
            .where(
              and(
                eq(weddingHosts.weddingId, weddingId),
                inArray(weddingHosts.id, jsonEachIn(seatIds)),
                inProfiles(weddingHosts.osnProfileId, profileIds),
                keepHeldSeat
                  ? sql`NOT ${heldSeatOf(outerColumn(weddingHosts.osnProfileId))}`
                  : undefined,
              ),
            )
            // Whether the seat's profile holds the wedding's payout account,
            // and the wedding is live after the batch's delete above (so
            // another owner remains). Reads `registry_settings` and `weddings`
            // only: RETURNING is filled row by row as the delete runs, so a
            // read of `wedding_hosts` here would see it half done.
            .returning({
              role: weddingHosts.role,
              osnProfileId: weddingHosts.osnProfileId,
              payoutHolder: sql<number>`(${holdsPayoutAccountSql(sql`${weddingId}`, outerColumn(weddingHosts.osnProfileId))} AND EXISTS (SELECT 1 FROM ${weddings} payout_wedding WHERE payout_wedding.id = ${weddingId} AND payout_wedding.deleted_at IS NULL))`,
            }),
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
    const taken = results[2] as ReadonlyArray<{
      role: string;
      osnProfileId: string;
      payoutHolder: number;
    }>;
    if (!deleted && taken.length === 0) return null;
    const owners = taken.filter((seat) => seat.role === "owner");
    const leavers = owners.map((seat) => seat.osnProfileId);
    const payoutHolderLeft = owners.some((seat) => Number(seat.payoutHolder) === 1);
    const outcome = deleted ? "deleted" : "seat_removed";
    metricAccountDeletionWedding(outcome);
    yield* Effect.logInfo("account erasure: a wedding the person owned").pipe(
      Effect.annotateLogs({ weddingId, outcome, payoutHolderLeft }),
    );
    const seatHolders = taken.map((seat) => seat.osnProfileId);
    return { weddingId, outcome, leavers, payoutHolderLeft, seatHolders } as const;
  }).pipe(Effect.withSpan("cire.account_deletion.wedding", { attributes: { weddingId } }));
}

/** One seat of the account as the call's first read found it. */
interface FirstReadSeat {
  readonly id: string;
  readonly profileId: string;
  readonly role: string;
}

/** A nullable column cleared where it names one of `profiles`. */
const clearedIn = (column: AnySQLiteColumn, profiles: ReadonlyArray<string>, to: string | null) =>
  sql`CASE WHEN ${inProfiles(column, profiles)} THEN ${to} ELSE ${column} END`;

/**
 * Everything of the account outside the weddings it owns, in one batch: seats
 * below owner and every notice row with no owner seat behind it, organiser
 * sessions (the `host` scope's only: an account's erasure ended them before
 * its weddings), guest account links (by the account or a profile; not for the
 * `host` scope), Stripe OAuth states, the profiles' budget rows, and every
 * column that names a profile (a vendor listing's claim columns not for the
 * `host` scope),
 * nullable ones to NULL (or {@link DELETED_PROFILE} where NULL means
 * something else, or `''` on the RSVP change log, where NULL means the
 * household's own change), and those that cannot be NULL to
 * {@link DELETED_PROFILE}. An
 * enquiry the person opened that no chat ever took is deleted, which frees the
 * wedding to enquire with that vendor again. Before the columns are cleared,
 * and not for the `host` scope, whose caller answers no kept item, a count of
 * the deleted weddings with no owner left whose deleter is one of the
 * profiles and that the purge holds: what the erasure answers it keeps.
 * A wedding's deleter is cleared only once no seat of the profiles is left,
 * so a call that answers not finished leaves it for the next one to count.
 * Last, a count of the seats the profiles still hold: owner seats (one made
 * owner since the call's first read), which the call must take first, and
 * seats below owner past this call's {@link MAX_LOWER_SEATS_PER_CALL}.
 *
 * Most of these UPDATEs scan their table: the columns are not indexed, and
 * they can name the person on weddings they left long ago. It runs once per
 * account, on the call that finishes.
 */
function eraseAccountRows(input: EraseInput, now: Date) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const p = input.profileIds;
    const host = input.scope === "host";
    const ownerSeatOfRow = sql`EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${outerColumn(hostRsvpNotices.weddingId)} AND ${weddingHosts.osnProfileId} = ${outerColumn(hostRsvpNotices.osnProfileId)} AND ${weddingHosts.role} = 'owner')`;
    // True once no seat of the profiles is left: every owner seat taken, and
    // every seat below owner, which this batch takes at most
    // MAX_LOWER_SEATS_PER_CALL of.
    const noSeatLeft = sql`NOT EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${inProfiles(weddingHosts.osnProfileId, p)})`;

    const results = yield* Effect.tryPromise({
      try: () =>
        commitBatchResults(db, [
          db
            .delete(hostRsvpNotices)
            .where(and(inProfiles(hostRsvpNotices.osnProfileId, p), sql`NOT ${ownerSeatOfRow}`)),
          db
            .delete(weddingHosts)
            .where(
              inArray(
                weddingHosts.id,
                db
                  .select({ id: weddingHosts.id })
                  .from(weddingHosts)
                  .where(
                    and(inProfiles(weddingHosts.osnProfileId, p), ne(weddingHosts.role, "owner")),
                  )
                  .orderBy(asc(weddingHosts.id))
                  .limit(MAX_LOWER_SEATS_PER_CALL),
              ),
            )
            .returning({
              weddingId: weddingHosts.weddingId,
              osnProfileId: weddingHosts.osnProfileId,
            }),
          // Read before the deleter is cleared below; third in the batch.
          ...(host
            ? []
            : [
                db
                  .select({ held: sql<number>`count(*)` })
                  .from(weddings)
                  .where(
                    and(
                      isNotNull(weddings.deletedAt),
                      inProfiles(weddings.deletedByOsnProfileId, p),
                      noOwnerLeft(),
                      purgeHeld(outerColumn(weddings.id), epochSeconds(now), now.getTime()),
                    ),
                  ),
              ]),
          // A host's removal ends the sessions only once no seat of the
          // profiles is left: a seat made owner since the call's first read,
          // or seats below owner past this call's share, answer not finished,
          // and the person keeps a session to call again with. An account's
          // erasure ended them before its weddings ({@link eraseWithOutcomes}).
          ...(host
            ? [
                db
                  .delete(organiserSessions)
                  .where(and(inProfiles(organiserSessions.osnProfileId, p), noSeatLeft)),
              ]
            : []),
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
              deletedByOsnProfileId: sql`CASE WHEN ${inProfiles(weddings.deletedByOsnProfileId, p)} AND ${noSeatLeft} THEN NULL ELSE ${weddings.deletedByOsnProfileId} END`,
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
          // A host's removal leaves the record of an account whose holder sits
          // as an owner on its wedding: one made owner since this call's first
          // read, whose seat the next call keeps ({@link payoutHeldSeat}).
          db
            .update(registrySettings)
            .set({ stripeConnectedByOsnProfileId: null })
            .where(
              and(
                inProfiles(registrySettings.stripeConnectedByOsnProfileId, p),
                host
                  ? sql`NOT EXISTS (SELECT 1 FROM ${weddingHosts} held_seat WHERE held_seat.wedding_id = ${outerColumn(registrySettings.weddingId)} AND held_seat.osn_profile_id = ${outerColumn(registrySettings.stripeConnectedByOsnProfileId)} AND held_seat.role = 'owner')`
                  : undefined,
              ),
            ),
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
            .select({
              owned: sql<number>`coalesce(sum(${weddingHosts.role} = 'owner'), 0)`,
              lower: sql<number>`coalesce(sum(${weddingHosts.role} <> 'owner'), 0)`,
            })
            .from(weddingHosts)
            .where(inProfiles(weddingHosts.osnProfileId, p)),
        ]),
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    }).pipe(
      Effect.tapError((err) =>
        Effect.logError("account erasure: the account's clean-up failed").pipe(
          Effect.annotateLogs({ reason: err.reason }),
        ),
      ),
    );
    // By position: the lower seats second, the held count third (none for the
    // `host` scope), the seats left last.
    const lower = results[1] as ReadonlyArray<{ weddingId: string; osnProfileId: string }>;
    const [held] = host ? [] : (results[2] as ReadonlyArray<{ held: number }>);
    const [left] = results[results.length - 1] as ReadonlyArray<{ owned: number; lower: number }>;
    return {
      ownerSeatsLeft: Number(left?.owned ?? 0),
      lowerSeatsLeft: Number(left?.lower ?? 0),
      lowerSeats: lower.map((row) => ({ weddingId: row.weddingId, profileId: row.osnProfileId })),
      lowerSeatWeddings: [...new Set(lower.map((row) => row.weddingId))],
      heldWeddings: Number(held?.held ?? 0),
    };
  }).pipe(Effect.withSpan("cire.account_deletion.cleanup"));
}

/**
 * The first read's seats as the weddings they sit on, in the read's order:
 * oldest owner seat first, then by id. Each carries every seat of the
 * profiles there.
 */
const ownedWeddings = (
  rows: ReadonlyArray<{
    id: string;
    weddingId: string;
    profileId: string;
    role: string;
    createdAt: Date;
  }>,
) => {
  const byWedding = new Map<string, { firstOwnerAt: number; seats: FirstReadSeat[] }>();
  for (const row of rows) {
    const entry = byWedding.get(row.weddingId) ?? { firstOwnerAt: Infinity, seats: [] };
    entry.seats.push({ id: row.id, profileId: row.profileId, role: row.role });
    if (row.role === "owner") {
      entry.firstOwnerAt = Math.min(entry.firstOwnerAt, row.createdAt.getTime());
    }
    byWedding.set(row.weddingId, entry);
  }
  return [...byWedding]
    .map(([weddingId, { firstOwnerAt, seats }]) => ({
      weddingId,
      firstOwnerAt,
      seats,
    }))
    .toSorted((a, b) =>
      a.firstOwnerAt !== b.firstOwnerAt
        ? a.firstOwnerAt - b.firstOwnerAt
        : a.weddingId < b.weddingId
          ? -1
          : 1,
    );
};

/**
 * Erases the account in cire, at the end of its deletion window or when the
 * person leaves cire as a host (`scope`): each wedding a profile owns
 * ({@link MAX_OWNED_WEDDINGS_PER_CALL} a call, oldest seat first; deleted when
 * no other owner is left), then, once none is left, everything else of the
 * account. A finished call of the `account` scope answers, as kept, the
 * deleted weddings of the person's the purge still holds ({@link keptItems});
 * cire keeps nothing else about them. Answers `not_finished` while owned
 * weddings remain, a seat was made owner since the first read, or seats below
 * owner remain past the call's share; the caller calls again. Beside the result,
 * what the call did to each wedding the person owned, for the notices a
 * removal sends.
 *
 * A host's removal (`scope: "host"`) keeps each owner seat whose profile holds
 * the wedding's payout account ({@link payoutHeldSeat}): such a call stops
 * before the account's clean-up, answers `not_finished`, and names those
 * weddings in `payoutHeld`, so its route can refuse with them. The route reads
 * the same rule before it calls; the writes hold it for a connect that lands
 * between the two.
 *
 * What the call has done so far is kept in `progress`, which the caller passes
 * when it must know what stands after a failure part way.
 */
function eraseWithOutcomes(
  input: EraseInput,
  progress: ErasureProgress = erasureProgress(),
): Effect.Effect<
  {
    readonly result: ErasureResult;
    readonly owned: ReadonlyArray<OwnedOutcome>;
    /** Weddings a seat below owner went from, on the call that ran the clean-up. */
    readonly lowerSeatWeddings: ReadonlyArray<string>;
    /** Weddings whose holder's owner seat a host's removal kept. Empty for an account's erasure. */
    readonly payoutHeld: ReadonlyArray<string>;
  },
  AccountErasureError,
  DbService
> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    // Every seat of the profiles on the first weddings they own, oldest owner
    // seat first, in one statement: each wedding's batch takes these seats, by
    // id, and the owner seats it returns are counted against them.
    const seatRows = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          db
            .select({
              id: weddingHosts.id,
              weddingId: weddingHosts.weddingId,
              profileId: weddingHosts.osnProfileId,
              role: weddingHosts.role,
              createdAt: weddingHosts.createdAt,
            })
            .from(weddingHosts)
            .where(
              and(
                inProfiles(weddingHosts.osnProfileId, input.profileIds),
                inArray(
                  weddingHosts.weddingId,
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
                    .limit(MAX_OWNED_WEDDINGS_PER_CALL + 1),
                ),
              ),
            )
            .all(),
        ),
      catch: (e) => new AccountErasureError({ reason: String(e) }),
    });
    const owned = ownedWeddings(seatRows);

    // An account's erasure ends the person's organiser sessions first, on
    // every call, so one that stops before its clean-up still ends them:
    // osn-api, not the person, makes the next call. A host's removal keeps
    // them for the portal's next call, and its clean-up ends them.
    if (input.scope !== "host") {
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(organiserSessions)
              .where(inProfiles(organiserSessions.osnProfileId, input.profileIds))
              .run(),
          ),
        catch: (e) => new AccountErasureError({ reason: String(e) }),
      });
    }

    const now = input.now ?? new Date();
    const keepHeldSeat = input.scope === "host";
    const outcomes = progress.owned;
    const payoutHeld: string[] = [];
    for (const { weddingId, seats } of owned.slice(0, MAX_OWNED_WEDDINGS_PER_CALL)) {
      progress.writing = { weddingId };
      // A batch that fails may have committed with its answer lost: it stays
      // the one being written, which the record lists as unsettled.
      const outcome = yield* eraseOwnedWedding(
        weddingId,
        seats,
        input.profileIds,
        now,
        keepHeldSeat,
      );
      progress.writing = null;
      if (outcome) outcomes.push(outcome);
      // Here, not after the loop: a later batch or the clean-up can fail the
      // call, and the call that finishes removes no seat, so it would not send.
      // After the outcome is in the progress, so the record holds what the
      // batch confirmed whatever the email does.
      if (outcome?.payoutHolderLeft && input.onPayoutHolderLeft) {
        yield* input.onPayoutHolderLeft(weddingId);
      }
      // An owner seat the first read found that the batch did not take: the
      // holder rule kept it. One another request took in between reads the
      // same, and costs only the portal's next call; the deletion record
      // lists the seats that went, not this. Matched by profile (one seat per
      // profile on a wedding), so a seat whose role changed in between counts
      // by the role the first read saw.
      const taken = new Set(outcome?.seatHolders ?? []);
      if (
        keepHeldSeat &&
        seats.some((seat) => seat.role === "owner" && !taken.has(seat.profileId))
      ) {
        payoutHeld.push(weddingId);
      }
    }
    const notFinished = (lowerSeatWeddings: ReadonlyArray<string>) => ({
      result: { status: "not_finished" } as const,
      owned: outcomes,
      lowerSeatWeddings,
      payoutHeld,
    });
    if (payoutHeld.length > 0 || owned.length > MAX_OWNED_WEDDINGS_PER_CALL) return notFinished([]);

    progress.writing = "clean_up";
    const { ownerSeatsLeft, lowerSeatsLeft, lowerSeats, lowerSeatWeddings, heldWeddings } =
      yield* eraseAccountRows(input, now);
    progress.writing = null;
    progress.cleanedUp = true;
    progress.lowerSeats.push(...lowerSeats);
    if (ownerSeatsLeft > 0 || lowerSeatsLeft > 0) return notFinished(lowerSeatWeddings);
    yield* Effect.annotateCurrentSpan({ heldWeddings });
    if (heldWeddings > 0) {
      yield* Effect.logInfo("account erasure: deleted weddings the purge holds").pipe(
        Effect.annotateLogs({ held: heldWeddings }),
      );
    }
    return {
      result: { status: "done", kept: keptItems(heldWeddings) } as const,
      owned: outcomes,
      lowerSeatWeddings,
      payoutHeld,
    };
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

export const accountErasureService = { preview, deletionPreview, erase, eraseWithOutcomes };
