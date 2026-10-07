/**
 * Redeeming an unlock code.
 *
 *   POST /api/organiser/weddings/:weddingId/unlock-code   (OWNER)
 *
 * **Owner-only**, like starting a purchase: a code changes what the wedding is
 * on. Limited per organiser, after the gate, so a stranger's request spends
 * nobody's budget.
 *
 * **NO tier gate**, deliberately: the route that raises a tier cannot sit
 * behind one.
 *
 * Answers:
 *   200 `{ tier }` — the wedding is on the code's tier now.
 *   404 `{ error: "unlock_code_invalid" }` — unknown, expired, used up or
 *       already used by this wedding, all alike, so guessing learns nothing.
 *   409 `{ error: "tier_already_held", tier }` — the wedding is already on the
 *       code's tier or above (`tier` is the wedding's). The code is not spent.
 *   409 `{ error: "purchase_in_flight" }` — an upgrade checkout for the
 *       wedding can still be paid. The code is not spent.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { RedeemUnlockCodeBody } from "../schemas/unlock-code";
import { unlockCodeService } from "../services/unlock-codes";

export const createUnlockCodeRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(limiter))
        .post(
          "/unlock-code",
          async ({ weddingId, osnProfileId, request, set }) => {
            if (!weddingId || !osnProfileId) {
              set.status = 500;
              return { error: "internal" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(RedeemUnlockCodeBody)(raw);
                return yield* unlockCodeService.redeem({
                  weddingId,
                  osnProfileId,
                  unlockCode: body.unlockCode,
                });
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () => {
                  set.status = 400;
                  return Effect.succeed({ error: "Missing or invalid fields" });
                }),
                Effect.catchTag("UnlockCodeRefused", () => {
                  set.status = 404;
                  return Effect.succeed({ error: "unlock_code_invalid" });
                }),
                Effect.catchTag("UnlockCodeTierHeld", (e) => {
                  set.status = 409;
                  return Effect.succeed({ error: "tier_already_held", tier: e.tier });
                }),
                Effect.catchTag("UnlockCodePurchaseInFlight", () => {
                  set.status = 409;
                  return Effect.succeed({ error: "purchase_in_flight" });
                }),
                Effect.catchTag("UnlockCodeWriteError", () => {
                  set.status = 500;
                  return Effect.succeed({ error: "internal" });
                }),
                Effect.tapDefect((cause) =>
                  Effect.logError("unlock code route failed", {
                    weddingId,
                    cause: String(cause),
                  }),
                ),
                Effect.catchDefect(() => {
                  set.status = 500;
                  return Effect.succeed({ error: "internal" });
                }),
              ),
            );
          },
          // The body is read by hand and decoded above, so a malformed one
          // reaches the schema's answer rather than a framework parse error.
          { parse: () => ({}) },
        ),
    );
