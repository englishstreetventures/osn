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
 * `{ entitlement }` — the contract behind the portal's faded nav row, which
 * offers the upgrade instead of opening the module.
 *
 * Reads `params.weddingId` directly (the role gate has already validated it);
 * a missing weddingId degrades to 402 rather than throwing.
 *
 * When the role gate has already parked an error, this derive returns without
 * touching D1. The role gate's onBeforeHandle is registered first and so
 * answers first, meaning that entitlement read could never change the response —
 * it only spent a query telling an unauthenticated or wrong-role caller apart.
 * Skipping it keeps the status ordering the routes are tested against (401, then
 * 403 `read_only_role`, then 402 `payment_required`) and denies an anonymous
 * caller a free D1 read on every request.
 *
 * Every mount site sits directly behind `weddingMember()`, `weddingEditor()` or
 * `weddingOwner()` called with this SAME `key`, which folds the entitlement
 * presence check into the role gate's own query. This derive picks that answer
 * up via `readWeddingEntitlementFold` instead of running
 * `entitlementService.has()` itself, so a gated route pays no query of its own
 * for the entitlement. `tests/routes/entitlement-gate-pairing.test.ts` fails
 * the build when a mount breaks that pairing. The `has()` call is the fallback
 * for a fold that is missing or answers a different key — a gate mounted
 * standalone (only in tests), or a role gate whose fold query defected — and
 * it answers correctly there, at the cost of one more query.
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
                Effect.catchDefect(() =>
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
