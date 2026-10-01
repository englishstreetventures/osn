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
export const PURCHASE_SESSION_LIFETIME_S = 24 * 60 * 60;

/** A session-less pending purchase is another request's attempt for this long. */
const STALE_PENDING_S = Math.ceil(STALE_PENDING_MS / 1000);

/**
 * How long a pending gift blocks a delete. Gifts may be paid by bank debit,
 * which settles days after checkout; a pending row older than this is an
 * abandoned checkout and does not block.
 */
export const GIFT_IN_FLIGHT_S = 7 * 24 * 60 * 60;

/** A wedding reference inside a fragment: a bound id, or the outer row's id. */
type WeddingRef = SQL | string;

/** An upgrade purchase whose payment can still land. `nowS` in seconds. */
export const purchaseInFlight = (wedding: WeddingRef, nowS: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${weddingUpgradePurchases} WHERE ${weddingUpgradePurchases.weddingId} = ${wedding} AND ${weddingUpgradePurchases.status} = 'pending' AND ((${weddingUpgradePurchases.checkoutSessionId} IS NOT NULL AND ${weddingUpgradePurchases.createdAt} > ${nowS - PURCHASE_SESSION_LIFETIME_S}) OR (${weddingUpgradePurchases.checkoutSessionId} IS NULL AND ${weddingUpgradePurchases.createdAt} > ${nowS - STALE_PENDING_S})))`;

/** A gift checkout recent enough to still settle. `nowS` in seconds. */
export const giftInFlight = (wedding: WeddingRef, nowS: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${registryContributions} WHERE ${registryContributions.weddingId} = ${wedding} AND ${registryContributions.status} = 'pending' AND ${registryContributions.createdAt} > ${nowS - GIFT_IN_FLIGHT_S})`;

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

export class WeddingLifecycleRefused extends Data.TaggedError("WeddingLifecycleRefused")<{
  readonly reason: LifecycleRefusal;
}> {}

export class WeddingLifecycleWriteError extends Data.TaggedError("WeddingLifecycleWriteError")<{
  readonly op: "delete" | "restore";
  readonly reason: string;
}> {}

export interface SoftDeleted {
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

/** The first reason, in the order an owner can act on them. */
function deleteRefusal(row: DeleteRefusalRow | undefined, confirmSlug: string): LifecycleRefusal {
  if (!row || row.deletedAt !== null) return "not_found";
  if (!row.owner) return "forbidden";
  if (row.slug !== confirmSlug) return "confirmation_mismatch";
  if (row.purchase) return "purchase_in_flight";
  if (row.gift) return "gift_in_flight";
  if (row.claimed) return "change_in_progress";
  // Every guard passed on the read and yet the write matched nothing: the
  // wedding moved between the two statements of one batch, which D1 does not
  // allow. Answered as the most conservative refusal rather than a success.
  return "change_in_progress";
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
  softDelete(input: {
    weddingId: string;
    osnProfileId: string;
    confirmSlug: string;
    now?: Date;
  }): Effect.Effect<SoftDeleted, WeddingLifecycleRefused | WeddingLifecycleWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = input.now ?? new Date();
      const nowS = epochSeconds(now);
      const nowMs = now.getTime();
      const { weddingId, osnProfileId, confirmSlug } = input;

      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db
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
              .returning({ id: weddings.id, deletedAt: weddings.deletedAt }),
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
              .where(eq(weddings.id, weddingId)),
          ]),
        catch: (e) => new WeddingLifecycleWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("wedding delete failed", { weddingId, reason: err.reason }),
        ),
      );

      const [written] = results[0] as readonly { id: string; deletedAt: Date | null }[];
      if (!written?.deletedAt) {
        const [row] = results[1] as readonly DeleteRefusalRow[];
        const reason = deleteRefusal(row, confirmSlug);
        yield* Effect.logWarning("wedding delete refused").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId, reason }),
        );
        return yield* new WeddingLifecycleRefused({ reason });
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
            err._tag === "WeddingLifecycleRefused" ? deletedResult(err.reason) : "error",
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
  restore(input: {
    weddingId: string;
    osnProfileId: string;
    now?: Date;
  }): Effect.Effect<
    { weddingId: string },
    WeddingLifecycleRefused | WeddingLifecycleWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = input.now ?? new Date();
      const windowStartS = epochSeconds(now) - RESTORE_WINDOW_S;
      const { weddingId, osnProfileId } = input;

      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db
              .update(weddings)
              .set({ deletedAt: null, deletedByOsnProfileId: null })
              .where(
                and(
                  eq(weddings.id, weddingId),
                  isNotNull(weddings.deletedAt),
                  sql`${weddings.deletedAt} > ${windowStartS}`,
                  ownerSeat(weddingId, osnProfileId),
                ),
              )
              .returning({ id: weddings.id }),
            db
              .select({
                deletedAt: weddings.deletedAt,
                owner: sql<number>`${ownerSeat(weddingId, osnProfileId)}`,
              })
              .from(weddings)
              .where(eq(weddings.id, weddingId)),
          ]),
        catch: (e) => new WeddingLifecycleWriteError({ op: "restore", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("wedding restore failed", { weddingId, reason: err.reason }),
        ),
      );

      const [written] = results[0] as readonly { id: string }[];
      if (!written) {
        const [row] = results[1] as readonly { deletedAt: Date | null; owner: number }[];
        const reason: LifecycleRefusal = !row
          ? "not_found"
          : !row.owner
            ? "forbidden"
            : row.deletedAt === null
              ? "not_deleted"
              : "restore_window_passed";
        yield* Effect.logWarning("wedding restore refused").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId, reason }),
        );
        return yield* new WeddingLifecycleRefused({ reason });
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
            err._tag === "WeddingLifecycleRefused" ? restoredResult(err.reason) : "error",
          ),
        ),
      ),
      Effect.withSpan("cire.wedding.restore"),
    );
  },
};
