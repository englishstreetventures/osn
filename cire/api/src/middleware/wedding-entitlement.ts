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
 */
export function weddingEntitlement(db: Db, key: EntitlementKey) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { params } = ctx as unknown as { params?: Record<string, string | undefined> };
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
