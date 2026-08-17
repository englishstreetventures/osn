import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { entitlementService } from "../services/entitlements";
import type { EntitlementKey } from "../services/entitlements";

interface EntitlementGateError {
  status: number;
  body: { error: string; entitlement: EntitlementKey };
}

/** What the role gate (weddingMember/weddingEditor) parks on the context. */
interface RoleGated {
  params?: Record<string, string | undefined>;
  weddingGateError?: { status: number; body: { error: string } };
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
 */
export function weddingEntitlement(db: Db, key: EntitlementKey) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { params, weddingGateError } = ctx as unknown as RoleGated;
      if (weddingGateError) {
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
      const entitled = await runCire(
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
