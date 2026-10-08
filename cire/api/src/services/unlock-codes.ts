/**
 * Unlock codes ([[wiki/cire/cire-entitlements]]). The platform owner mints a
 * code with `scripts/mint-unlock-code.ts`; any owner of a wedding redeems it,
 * and the wedding moves to the code's tier with no payment.
 *
 * A code is a recovery code in form — 16 hex characters, 64 bits — and is
 * stored only as `hashRecoveryCode` of what was typed, which folds case and
 * drops dashes and spaces, so the lookup is a hash match on a unique index.
 *
 * **One D1 batch, one round trip.** D1 runs a batch as one transaction, one at
 * a time, so every rule is checked inside the statement that writes:
 *
 *  1. The redemption row, inserted from the code's row only while the code is
 *     unexpired, has a use left and has not been redeemed by this wedding, the
 *     wedding is live and on a tier below the code's, and no upgrade checkout
 *     for the wedding can still be paid. Of two redemptions racing for a
 *     code's last use, the second runs after the first and finds none left.
 *  2. The code's `redeemed_count`, raised by one — only when statement 1 wrote
 *     its row, which is the only way it can reach the code.
 *  3. The wedding's tier, raised to the code's — again only through that row.
 *  4. A read of what happened, and why when nothing did.
 *
 * On bun:sqlite (tests, `local.ts`) the four run one at a time outside a
 * transaction, so the atomicity holds on D1 only.
 *
 * **Every unusable code gets one answer.** Unknown, expired, used up, already
 * used by this wedding: all are {@link UnlockCodeRefused}, so guessing learns
 * nothing about which codes exist. A live code on a wedding already at or
 * above its tier is {@link UnlockCodeTierHeld}, which names the WEDDING's tier
 * and spends nothing: a code never lowers or repeats a tier. That answer, and
 * {@link UnlockCodePurchaseInFlight}, do tell someone already holding a live
 * code that it is live; finding one takes about 2^64 guesses.
 */
import { unlockCodeRedemptions, unlockCodes, weddings } from "@cire/db";
import { hashRecoveryCode } from "@shared/crypto/recovery";
import { and, eq, gt, inArray, isNull, lt, not, notExists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { bound, commitBatchResults, DbService, outerColumn } from "../db";
import type { Db } from "../db";
import { epochSeconds, weddingIsLive } from "../db/live-wedding";
import { metricUnlockCodeRedemption } from "../metrics";
import { isPaidTier, normaliseTier, tierRankSql } from "./tiers";
import type { PaidTier, Tier } from "./tiers";
import { purchaseInFlight } from "./wedding-lifecycle";

/** Unknown, expired, used up, or already redeemed by this wedding — one answer. */
export class UnlockCodeRefused extends Data.TaggedError("UnlockCodeRefused") {}

/** A live code on a wedding already on its tier or above. Nothing was spent. */
export class UnlockCodeTierHeld extends Data.TaggedError("UnlockCodeTierHeld")<{
  /** The wedding's own tier, never the code's. */
  readonly tier: Tier;
}> {}

/** A live code refused because an upgrade checkout for the wedding can still be paid. */
export class UnlockCodePurchaseInFlight extends Data.TaggedError("UnlockCodePurchaseInFlight") {}

export class UnlockCodeWriteError extends Data.TaggedError("UnlockCodeWriteError")<{
  readonly reason: string;
}> {}

export interface RedeemUnlockCode {
  readonly weddingId: string;
  /** The owner redeeming, already admitted by `weddingOwner()`. */
  readonly osnProfileId: string;
  /** What the owner typed. */
  readonly unlockCode: string;
  readonly now?: Date;
}

/** The code with `hash` can still be used — unexpired, with a use left — and
 *  this wedding has not redeemed it. For a statement reading `unlock_codes`. */
function codeUsable(db: Db, hash: string, weddingId: string, now: Date): SQL {
  return and(
    eq(unlockCodes.codeHash, hash),
    or(isNull(unlockCodes.expiresAt), gt(unlockCodes.expiresAt, now)),
    lt(unlockCodes.redeemedCount, unlockCodes.maxRedemptions),
    notExists(
      db
        .select({ one: sql`1` })
        .from(unlockCodeRedemptions)
        .where(
          and(
            eq(unlockCodeRedemptions.codeId, outerColumn(unlockCodes.id)),
            eq(unlockCodeRedemptions.weddingId, weddingId),
          ),
        ),
    ),
  )!;
}

/** The code the redemption row `redemptionId` spent, as a scalar subquery. */
const spentCodeId = (db: Db, redemptionId: string) =>
  db
    .select({ codeId: unlockCodeRedemptions.codeId })
    .from(unlockCodeRedemptions)
    .where(eq(unlockCodeRedemptions.id, redemptionId));

interface Outcome {
  tier: string | null;
  codeId: string | null;
  codeLive: number;
  purchase: number;
}

export const unlockCodeService = {
  redeem(
    input: RedeemUnlockCode,
  ): Effect.Effect<
    { tier: PaidTier },
    UnlockCodeRefused | UnlockCodeTierHeld | UnlockCodePurchaseInFlight | UnlockCodeWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = input.now ?? new Date();
      const nowS = epochSeconds(now);
      const { weddingId, osnProfileId } = input;
      const hash = hashRecoveryCode(input.unlockCode);
      const redemptionId = `ulr_${crypto.randomUUID()}`;

      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db.insert(unlockCodeRedemptions).select(
              // Every column, in the table's order.
              db
                .select({
                  id: bound(redemptionId, unlockCodeRedemptions.id),
                  codeId: unlockCodes.id,
                  weddingId: bound(weddingId, unlockCodeRedemptions.weddingId),
                  redeemedByOsnProfileId: bound(
                    osnProfileId,
                    unlockCodeRedemptions.redeemedByOsnProfileId,
                  ),
                  redeemedAt: bound(now, unlockCodeRedemptions.redeemedAt),
                })
                .from(unlockCodes)
                .where(
                  and(
                    codeUsable(db, hash, weddingId, now),
                    sql`EXISTS (SELECT 1 FROM ${weddings} WHERE ${weddings.id} = ${weddingId} AND ${weddings.deletedAt} IS NULL AND ${tierRankSql(weddings.tier)} < ${tierRankSql(outerColumn(unlockCodes.tier))})`,
                    not(purchaseInFlight(weddingId, nowS)),
                  ),
                ),
            ),
            db
              .update(unlockCodes)
              .set({ redeemedCount: sql`${unlockCodes.redeemedCount} + 1` })
              .where(inArray(unlockCodes.id, spentCodeId(db, redemptionId))),
            db
              .update(weddings)
              .set({
                tier: sql`(SELECT ${unlockCodes.tier} FROM ${unlockCodes} WHERE ${unlockCodes.id} = (${spentCodeId(db, redemptionId)}))`,
                tierSource: "code",
                tierGrantedBy: sql`'code:' || (${spentCodeId(db, redemptionId)})`,
              })
              .where(
                and(
                  eq(weddings.id, weddingId),
                  inArray(
                    weddings.id,
                    db
                      .select({ weddingId: unlockCodeRedemptions.weddingId })
                      .from(unlockCodeRedemptions)
                      .where(eq(unlockCodeRedemptions.id, redemptionId)),
                  ),
                ),
              ),
            db
              .select({
                tier: weddings.tier,
                codeId: sql<string | null>`(${spentCodeId(db, redemptionId)})`,
                codeLive: sql<number>`EXISTS (SELECT 1 FROM ${unlockCodes} WHERE ${codeUsable(db, hash, weddingId, now)})`,
                purchase: sql<number>`${purchaseInFlight(weddingId, nowS)}`,
              })
              .from(weddings)
              .where(and(eq(weddings.id, weddingId), weddingIsLive)),
          ]),
        catch: (e) => new UnlockCodeWriteError({ reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("unlock code redemption failed").pipe(
            Effect.annotateLogs({ weddingId, reason: err.reason }),
          ),
        ),
      );

      const [row] = results[3] as readonly Outcome[];
      const tier = normaliseTier(row?.tier);

      if (row?.codeId && isPaidTier(tier)) {
        metricUnlockCodeRedemption("redeemed");
        yield* Effect.logInfo("unlock code redeemed").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId, codeId: row.codeId, tier }),
        );
        return { tier };
      }
      if (row && Boolean(row.codeLive) && Boolean(row.purchase)) {
        metricUnlockCodeRedemption("purchase_in_flight");
        yield* Effect.logInfo("unlock code held back by an open checkout").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId }),
        );
        return yield* new UnlockCodePurchaseInFlight();
      }
      if (row && Boolean(row.codeLive)) {
        metricUnlockCodeRedemption("already_held");
        yield* Effect.logInfo("unlock code not needed: tier already held").pipe(
          Effect.annotateLogs({ weddingId, profileId: osnProfileId, tier }),
        );
        return yield* new UnlockCodeTierHeld({ tier });
      }
      metricUnlockCodeRedemption("refused");
      yield* Effect.logWarning("unlock code refused").pipe(
        Effect.annotateLogs({ weddingId, profileId: osnProfileId }),
      );
      return yield* new UnlockCodeRefused();
    }).pipe(Effect.withSpan("cire.tier.redeemUnlockCode"));
  },
};
