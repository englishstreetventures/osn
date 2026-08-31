import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { entitlementService } from "../services/entitlements";
import type { EntitlementKey } from "../services/entitlements";
import { hasWeddingGateError, readWeddingEntitlementFold } from "./upstream-context";

interface EntitlementGateError {
  status: number;
  body: { error: string; entitlement: EntitlementKey };
}

/**
 * Entitlement gate for /api/organiser/weddings/:weddingId/* routes whose feature
 * is a paid pack. Sits AFTER the role gate (weddingMember/weddingEditor) and
 * BEFORE the rate limiter: a viewer on an entitled wedding is already stopped by
 * the role gate's 403, so a 402 here only reaches callers who ARE allowed by role
 * but whose WEDDING has not bought `key`. Returns 402 `payment_required` +
 * `{ entitlement }` — the contract the portal turns into an upsell.
 *
 * Reads `params.weddingId` directly (the role gate has already validated it);
 * a missing weddingId degrades to 402 rather than throwing.
 *
 * S-L2: when the role gate has already parked an error, this derive returns
 * without touching D1. The role gate's onBeforeHandle is registered first and so
 * answers first, meaning that entitlement read could never change the response —
 * it only spent a query telling an unauthenticated or wrong-role caller apart.
 * Skipping it keeps the status ordering the routes are tested against (401, then
 * 403 `read_only_role`, then 402 `payment_required`) and denies an anonymous
 * caller a free D1 read on every request.
 *
 * P-W1: every mount site sits directly behind `weddingMember()`/`weddingEditor()`
 * (see those files), which — called with this SAME `key` — already folded the
 * entitlement presence check into its own authorize() query, no extra round
 * trip. This derive picks that answer up via `readWeddingEntitlementFold`
 * rather than running `entitlementService.has()` itself, so a gated route no
 * longer pays for a THIRD query on top of the role gate's own. The `has()` call
 * survives as a fallback for the (currently only-in-tests) case of this gate
 * mounted standalone with no preceding role gate, or one that ran without a
 * key — it must still answer correctly there, just at the old cost.
 */
export function weddingEntitlement(db: Db, key: EntitlementKey) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { params } = ctx;
      if (hasWeddingGateError(ctx)) {
        return { entitlementGateError: undefined as EntitlementGateError | undefined };
      }
      const weddingId = params?.weddingId;
      if (!weddingId) {
        return {
          entitlementGateError: {
            status: 402,
            body: { error: "payment_required", entitlement: key },
          } as EntitlementGateError | undefined,
        };
      }
      const fold = readWeddingEntitlementFold(ctx);
      const entitled =
        fold && fold.key === key
          ? fold.entitled
          : await runCire(
              entitlementService.has(weddingId, key).pipe(
                Effect.provideService(DbService, db),
                Effect.catchAllDefect(() =>
                  Effect.logWarning("cire.entitlement.gate check failed — failing closed").pipe(
                    Effect.annotateLogs({ weddingId, entitlement: key }),
                    Effect.as(false),
                  ),
                ),
              ),
            );
      return {
        entitlementGateError: entitled
          ? (undefined as EntitlementGateError | undefined)
          : ({ status: 402, body: { error: "payment_required", entitlement: key } } as
              | EntitlementGateError
              | undefined),
      };
    })
    .onBeforeHandle({ as: "scoped" }, ({ entitlementGateError, set }) => {
      if (entitlementGateError) {
        set.status = entitlementGateError.status;
        return entitlementGateError.body;
      }
    });
}
