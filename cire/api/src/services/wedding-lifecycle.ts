/**
 * An owner deletes a wedding, any owner restores it, and the daily purge
 * hard-deletes it once the restore window has passed.
 *
 * Deleting is a SOFT delete: it sets `weddings.deleted_at` and touches nothing
 * else — no row, no R2 object, no session. Every read that could reach the
 * wedding carries the live-wedding predicate (`../db/live-wedding`), so from
 * that moment it is gone for guests, vendors and co-hosts, and its owners see
 * it only to restore it. A restore clears the column and everything is as it
 * was, guests' sessions and codes included.
 *
 * Every guard sits inside the statement that writes, as the owner-seat guards
 * in `hosts.ts` do: D1 offers no transaction across two requests, so a check
 * read before the write could be stale by the time it lands. A refused write
 * changes nothing, and a read in the same batch names the reason it saw.
 *
 * UNITS. `weddings.deleted_at` and the `created_at` of purchases and gifts are
 * epoch SECONDS (`mode: "timestamp"`); `weddings.change_claimed_at` is epoch
 * MILLISECONDS. Each fragment below says which it takes.
 */
import { registryContributions, weddingHosts, weddings, weddingUpgradePurchases } from "@cire/db";
import { and, eq, isNotNull, isNull, not, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatchResults, DbService } from "../db";
import { epochSeconds, RESTORE_WINDOW_S, restoreUntil } from "../db/live-wedding";
import { metricWeddingDeleted, metricWeddingRestored } from "../metrics";
import type { WeddingDeletedResult, WeddingRestoredResult } from "../metrics";
import { CLAIM_TTL_MS } from "./changes";
import { STALE_PENDING_MS } from "./upgrades";

/**
 * How long a pending upgrade purchase that has a Checkout session can still be
 * paid. The platform session is card-only and sets no `expires_at`, so Stripe
 * closes it this long after creation; nothing pays after that.
 */
const PURCHASE_SESSION_LIFETIME_S = 24 * 60 * 60;

/** A session-less pending purchase is another request's attempt for this long. */
const STALE_PENDING_S = Math.ceil(STALE_PENDING_MS / 1000);

/**
 * How long a gift's Checkout page can still be paid. The gift checkout sets no
 * `expires_at`, so Stripe closes it this long after creation. Counted from the
 * pending row, which is written just before the session is created.
 */
const GIFT_SESSION_LIFETIME_S = 24 * 60 * 60;

/**
 * How long a gift whose checkout has completed but whose money has not moved —
 * a delayed bank debit — blocks a delete. The debit settles days after
 * checkout; a pending row older than this does not block.
 */
const GIFT_IN_FLIGHT_S = 7 * 24 * 60 * 60;

/** A wedding reference inside a fragment: a bound id, or the outer row's id. */
type WeddingRef = SQL | string;

/** An upgrade purchase whose payment can still land. `nowS` in seconds. */
export const purchaseInFlight = (wedding: WeddingRef, nowS: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${weddingUpgradePurchases} WHERE ${weddingUpgradePurchases.weddingId} = ${wedding} AND ${weddingUpgradePurchases.status} = 'pending' AND ((${weddingUpgradePurchases.checkoutSessionId} IS NOT NULL AND ${weddingUpgradePurchases.createdAt} > ${nowS - PURCHASE_SESSION_LIFETIME_S}) OR (${weddingUpgradePurchases.checkoutSessionId} IS NULL AND ${weddingUpgradePurchases.createdAt} > ${nowS - STALE_PENDING_S})))`;

/**
 * A gift whose money can still move. `nowS` in seconds. Only a pending gift
 * with a Checkout session counts, and only while its page can still be paid
 * ({@link GIFT_SESSION_LIFETIME_S}) or, once the checkout has completed — the
 * settle records the payment intent and leaves the row pending — while a
 * delayed debit can still settle ({@link GIFT_IN_FLIGHT_S}). A pending row
 * with no session never got a payment page, so it never blocks: any guest can
 * write one, and it must not hold the owners' delete. The purge's own hold
 * still waits on every pending gift, so nothing that settles late is lost.
 */
const giftInFlight = (wedding: WeddingRef, nowS: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${registryContributions} WHERE ${registryContributions.weddingId} = ${wedding} AND ${registryContributions.status} = 'pending' AND ${registryContributions.stripeCheckoutSessionId} IS NOT NULL AND (${registryContributions.createdAt} > ${nowS - GIFT_SESSION_LIFETIME_S} OR (${registryContributions.stripePaymentIntentId} IS NOT NULL AND ${registryContributions.createdAt} > ${nowS - GIFT_IN_FLIGHT_S})))`;

/**
 * A change apply or revert holding the wedding right now. Reads the row the
 * statement is about (`weddings` must be the statement's table). `nowMs` in
 * MILLISECONDS, the unit of `change_claimed_at`.
 */
export const changeClaimLive = (nowMs: number): SQL =>
  sql`(${weddings.changeClaim} IS NOT NULL AND ${weddings.changeClaimedAt} > ${nowMs - CLAIM_TTL_MS})`;

/** The caller holds an `owner` seat on the wedding. */
const ownerSeat = (weddingId: string, osnProfileId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.osnProfileId} = ${osnProfileId} AND ${weddingHosts.role} = 'owner')`;

/** Why a delete or a restore wrote nothing. */
export type LifecycleRefusal =
  | "not_found"
  | "forbidden"
  | "confirmation_mismatch"
  | "purchase_in_flight"
  | "gift_in_flight"
  | "change_in_progress"
  | "not_deleted"
  | "restore_window_passed";

class WeddingLifecycleRefused extends Data.TaggedError("WeddingLifecycleRefused")<{
  readonly reason: LifecycleRefusal;
}> {}

class WeddingLifecycleWriteError extends Data.TaggedError("WeddingLifecycleWriteError")<{
  readonly op: "delete" | "restore";
  readonly reason: string;
}> {}

interface SoftDeleted {
  weddingId: string;
  deletedAt: Date;
  restoreUntil: Date;
}

type DeleteRefusalRow = {
  slug: string;
  deletedAt: Date | null;
  owner: number;
  purchase: number;
  gift: number;
  claimed: number;
};

/** The first reason a delete is refused, in the order an owner can act on them; null when none. */
function deleteBlock(
  row: DeleteRefusalRow | undefined,
  confirmSlug: string,
): LifecycleRefusal | null {
  if (!row || row.deletedAt !== null) return "not_found";
  if (!row.owner) return "forbidden";
  if (row.slug !== confirmSlug) return "confirmation_mismatch";
  if (row.purchase) return "purchase_in_flight";
  if (row.gift) return "gift_in_flight";
  if (row.claimed) return "change_in_progress";
  return null;
}

/** Why a delete's guarded write matched nothing, from a read of its guards after it. */
function deleteRefusal(row: DeleteRefusalRow | undefined, confirmSlug: string): LifecycleRefusal {
  // Every guard passing on that read while the write matched nothing means
  // the wedding moved between the write and the read. Answered as the most
  // conservative refusal rather than a success.
  return deleteBlock(row, confirmSlug) ?? "change_in_progress";
}

type RestoreRefusalRow = { deletedAt: Date | null; owner: number };

/** The first reason a restore is refused; null when none. `windowStartS` in seconds. */
function restoreBlock(
  row: RestoreRefusalRow | undefined,
  windowStartS: number,
): LifecycleRefusal | null {
  if (!row) return "not_found";
  if (!row.owner) return "forbidden";
  if (row.deletedAt === null) return "not_deleted";
  if (epochSeconds(row.deletedAt) <= windowStartS) return "restore_window_passed";
  return null;
}

const deletedResult = (reason: LifecycleRefusal): WeddingDeletedResult =>
  reason === "not_deleted" || reason === "restore_window_passed" ? "error" : reason;

const restoredResult = (reason: LifecycleRefusal): WeddingRestoredResult =>
  reason === "not_deleted" ||
  reason === "restore_window_passed" ||
  reason === "forbidden" ||
  reason === "not_found"
    ? reason
    : "error";

export const weddingLifecycleService = {
  /**
   * Soft-delete a wedding. One guarded UPDATE that sets only `deleted_at` and
   * `deleted_by_osn_profile_id`, refused unless every one of these holds at
   * the moment it writes: the wedding is live, `confirmSlug` is its slug, the
   * caller holds an owner seat, no upgrade payment can still land, no gift
   * checkout is recent enough to settle, and no change is mid-apply.
   */
  softDelete<E = never>(input: {
    weddingId: string;
    osnProfileId: string;
    confirmSlug: string;
    now?: Date;
    /**
     * Runs once the delete is accepted — every guard holds on a read just
     * before the write — and before anything is written; its failure fails
     * the delete with nothing written. The route records the deletion here; a
     * caller re-applying a recorded one passes none. The guarded write still
     * re-proves every guard.
     */
    beforeWrite?: (deletion: { readonly at: number }) => Effect.Effect<void, E>;
  }): Effect.Effect<
    SoftDeleted,
    WeddingLifecycleRefused | WeddingLifecycleWriteError | E,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = input.now ?? new Date();
      const nowS = epochSeconds(now);
      const nowMs = now.getTime();
      const { weddingId, osnProfileId, confirmSlug, beforeWrite } = input;
      const guards = () =>
        db
          .select({
            slug: weddings.slug,
            deletedAt: weddings.deletedAt,
            owner: sql<number>`${ownerSeat(weddingId, osnProfileId)}`,
            purchase: sql<number>`${purchaseInFlight(weddingId, nowS)}`,
            gift: sql<number>`${giftInFlight(weddingId, nowS)}`,
            claimed: sql<number>`${changeClaimLive(nowMs)}`,
          })
          .from(weddings)
          .where(eq(weddings.id, weddingId));
      const refuse = (reason: LifecycleRefusal) =>
        Effect.logWarning("wedding delete refused").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId, reason }),
          Effect.andThen(Effect.fail(new WeddingLifecycleRefused({ reason }))),
        );

      if (beforeWrite) {
        const [ahead] = yield* Effect.tryPromise({
          try: () => guards(),
          catch: (e) => new WeddingLifecycleWriteError({ op: "delete", reason: String(e) }),
        });
        const blocked = deleteBlock(ahead, confirmSlug);
        if (blocked !== null) return yield* refuse(blocked);
        yield* beforeWrite({ at: nowMs });
      }

      const update = db
        .update(weddings)
        .set({ deletedAt: now, deletedByOsnProfileId: osnProfileId })
        .where(
          and(
            eq(weddings.id, weddingId),
            eq(weddings.slug, confirmSlug),
            isNull(weddings.deletedAt),
            ownerSeat(weddingId, osnProfileId),
            not(purchaseInFlight(weddingId, nowS)),
            not(giftInFlight(weddingId, nowS)),
            not(changeClaimLive(nowMs)),
          ),
        )
        .returning({ id: weddings.id, deletedAt: weddings.deletedAt });
      const writeFailed = (e: unknown) =>
        new WeddingLifecycleWriteError({ op: "delete", reason: String(e) });
      // With the guards read ahead, the batch is the write alone, and the
      // guards are read again only when it matches nothing.
      const results = yield* Effect.tryPromise({
        try: () => commitBatchResults(db, beforeWrite ? [update] : [update, guards()]),
        catch: writeFailed,
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("wedding delete failed", { weddingId, reason: err.reason }),
        ),
      );

      const [written] = results[0] as readonly { id: string; deletedAt: Date | null }[];
      if (!written?.deletedAt) {
        const [row] = beforeWrite
          ? yield* Effect.tryPromise({ try: () => guards(), catch: writeFailed })
          : (results[1] as readonly DeleteRefusalRow[]);
        return yield* refuse(deleteRefusal(row, confirmSlug));
      }

      yield* Effect.logInfo("wedding soft-deleted").pipe(
        Effect.annotateLogs({ weddingId, profileId: osnProfileId }),
      );
      return {
        weddingId,
        deletedAt: written.deletedAt,
        restoreUntil: restoreUntil(written.deletedAt),
      };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricWeddingDeleted("ok"))),
      Effect.tapError((err) =>
        Effect.sync(() =>
          metricWeddingDeleted(
            err instanceof WeddingLifecycleRefused ? deletedResult(err.reason) : "error",
          ),
        ),
      ),
      Effect.withSpan("cire.wedding.delete"),
    );
  },

  /**
   * Restore a soft-deleted wedding. Any owner may, not only the one who
   * deleted it, until the restore window closes. One guarded UPDATE that
   * clears both columns; nothing else was ever changed, so nothing else needs
   * putting back.
   */
  restore<E = never>(input: {
    weddingId: string;
    osnProfileId: string;
    now?: Date;
    /**
     * Runs once the restore is accepted — every guard holds on a read just
     * before the write — and before anything is written. The route records
     * the restore here; a caller re-applying a recorded one passes none.
     */
    beforeWrite?: (restore: { readonly at: number }) => Effect.Effect<void, E>;
  }): Effect.Effect<
    { weddingId: string },
    WeddingLifecycleRefused | WeddingLifecycleWriteError | E,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = input.now ?? new Date();
      const windowStartS = epochSeconds(now) - RESTORE_WINDOW_S;
      const { weddingId, osnProfileId, beforeWrite } = input;
      const guards = () =>
        db
          .select({
            deletedAt: weddings.deletedAt,
            owner: sql<number>`${ownerSeat(weddingId, osnProfileId)}`,
          })
          .from(weddings)
          .where(eq(weddings.id, weddingId));
      const refuse = (reason: LifecycleRefusal) =>
        Effect.logWarning("wedding restore refused").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId, reason }),
          Effect.andThen(Effect.fail(new WeddingLifecycleRefused({ reason }))),
        );

      const writeFailed = (e: unknown) =>
        new WeddingLifecycleWriteError({ op: "restore", reason: String(e) });
      // The deletion the read ahead saw: with it, the write restores that
      // deletion and no later one, so its record names what it undid.
      let seen: Date | null = null;
      if (beforeWrite) {
        const [ahead] = yield* Effect.tryPromise({ try: () => guards(), catch: writeFailed });
        const blocked = restoreBlock(ahead, windowStartS);
        if (blocked !== null) return yield* refuse(blocked);
        seen = ahead?.deletedAt ?? null;
        yield* beforeWrite({ at: now.getTime() });
      }

      const update = db
        .update(weddings)
        .set({ deletedAt: null, deletedByOsnProfileId: null })
        .where(
          and(
            eq(weddings.id, weddingId),
            isNotNull(weddings.deletedAt),
            sql`${weddings.deletedAt} > ${windowStartS}`,
            ownerSeat(weddingId, osnProfileId),
            seen === null ? undefined : eq(weddings.deletedAt, seen),
          ),
        )
        .returning({ id: weddings.id });
      // With the guards read ahead, the batch is the write alone, and the
      // guards are read again only when it matches nothing.
      const results = yield* Effect.tryPromise({
        try: () => commitBatchResults(db, beforeWrite ? [update] : [update, guards()]),
        catch: writeFailed,
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("wedding restore failed", { weddingId, reason: err.reason }),
        ),
      );

      const [written] = results[0] as readonly { id: string }[];
      if (!written) {
        const [row] = beforeWrite
          ? yield* Effect.tryPromise({ try: () => guards(), catch: writeFailed })
          : (results[1] as readonly RestoreRefusalRow[]);
        // The write matched nothing while the guards read as restorable: the
        // wedding's deletion changed between the read and the write.
        return yield* refuse(restoreBlock(row, windowStartS) ?? "change_in_progress");
      }

      yield* Effect.logInfo("wedding restored").pipe(
        Effect.annotateLogs({ weddingId, profileId: osnProfileId }),
      );
      return { weddingId };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricWeddingRestored("ok"))),
      Effect.tapError((err) =>
        Effect.sync(() =>
          metricWeddingRestored(
            err instanceof WeddingLifecycleRefused ? restoredResult(err.reason) : "error",
          ),
        ),
      ),
      Effect.withSpan("cire.wedding.restore"),
    );
  },
};
