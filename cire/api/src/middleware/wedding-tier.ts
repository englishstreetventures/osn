import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { metricTierGatePaymentRequired } from "../metrics";
import { runCire } from "../observability";
import { tierAtLeast, tierService } from "../services/tiers";
import type { PaidTier, Tier } from "../services/tiers";
import { hasWeddingGateError, readWeddingTier } from "./upstream-context";

interface TierGateError {
  status: 402;
  body: { error: "payment_required"; tier: PaidTier };
}

/**
 * Plan-tier gate for /api/organiser/weddings/:weddingId/* routes whose module
 * belongs to a paid tier. Sits AFTER the role gate and BEFORE the rate limiter:
 * a viewer is already stopped by the role gate's 403, so a 402 here only
 * reaches callers who ARE allowed by role but whose WEDDING is on a tier below
 * `min`. Answers 402 `{ error: "payment_required", tier: min }` — the tier
 * that unlocks the route, which is what the portal's upgrade offer names.
 *
 * Every mount sits directly behind `weddingMember()`, `weddingEditor()`,
 * `weddingOwner()` or `weddingRunSheet()`, each of which reads the wedding's
 * tier from the row it already selects and parks it on the context as
 * `weddingTier`. This derive reads that, so a gated route costs no query of its
 * own. `tests/routes/tier-gate-pairing.test.ts` fails the build when a mount
 * breaks that pairing. Mounted standalone (only in tests) it reads the tier
 * itself, and a read that fails denies with a log line naming the wedding.
 *
 * When the role gate has already parked an error, this derive returns without
 * reading anything: the role gate's onBeforeHandle is registered first and so
 * answers first, keeping the status order routes are tested against (401, then
 * 403, then 402 `payment_required`).
 *
 * A missing `weddingId` in `params` (the role gate has already validated it)
 * degrades to the 402 rather than throwing.
 */
export function weddingTier(db: Db, min: PaidTier) {
  const refusal: TierGateError = { status: 402, body: { error: "payment_required", tier: min } };
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      if (hasWeddingGateError(ctx))
        return { tierGateError: undefined as TierGateError | undefined };
      const weddingId = ctx.params?.weddingId;
      if (!weddingId) return { tierGateError: refusal as TierGateError | undefined };

      const held: Tier =
        readWeddingTier(ctx) ??
        (await runCire(
          tierService.tierOf(weddingId).pipe(
            Effect.provideService(DbService, db),
            Effect.catchDefect(() =>
              Effect.logWarning("cire.tier.gate tier read failed — failing closed").pipe(
                Effect.annotateLogs({ weddingId, requiredTier: min }),
                Effect.as("ivory" as const),
              ),
            ),
          ),
        ));
      if (tierAtLeast(held, min)) return { tierGateError: undefined as TierGateError | undefined };

      metricTierGatePaymentRequired(min);
      await runCire(
        Effect.logWarning("cire.tier.gate payment required").pipe(
          Effect.annotateLogs({ weddingId, requiredTier: min, tier: held }),
        ),
      );
      return { tierGateError: refusal as TierGateError | undefined };
    })
    .onBeforeHandle({ as: "scoped" }, ({ tierGateError, set }) => {
      if (tierGateError) {
        set.status = tierGateError.status;
        return tierGateError.body;
      }
    });
}
