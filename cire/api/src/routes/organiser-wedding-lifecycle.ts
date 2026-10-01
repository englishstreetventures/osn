import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingOwner, weddingOwnerIncludingDeleted } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { DeleteWeddingBody } from "../schemas/wedding";
import { weddingLifecycleService } from "../services/wedding-lifecycle";
import type { LifecycleRefusal } from "../services/wedding-lifecycle";

// Sentinel parse hook: the delete handler reads `request.json()` itself so a
// malformed body is the route's own 400, not Elysia's parse error.
const manualParse = { parse: () => ({}) };

type SetStatus = { status?: number | string };

/** Each refusal's status and body. The guest-facing paths never see these. */
const REFUSALS = {
  not_found: { status: 404, error: "wedding_not_found" },
  forbidden: { status: 403, error: "forbidden" },
  confirmation_mismatch: { status: 400, error: "confirmation_mismatch" },
  purchase_in_flight: { status: 409, error: "purchase_in_flight" },
  gift_in_flight: { status: 409, error: "gift_in_flight" },
  change_in_progress: { status: 409, error: "change_in_progress" },
  not_deleted: { status: 409, error: "not_deleted" },
  restore_window_passed: { status: 409, error: "restore_window_passed" },
} as const satisfies Record<LifecycleRefusal, { status: number; error: string }>;

const refused = (set: SetStatus, reason: LifecycleRefusal) =>
  Effect.sync(() => {
    const { status, error } = REFUSALS[reason];
    set.status = status;
    return { error };
  });

const failed = (set: SetStatus, error: string) =>
  Effect.sync(() => {
    set.status = 500;
    return { error };
  });

/**
 * DELETE /api/organiser/weddings/:weddingId — an owner soft-deletes the wedding.
 *
 * Body `{ confirmSlug }`: the wedding's slug, typed exactly. One owner's
 * confirmation is enough — every owner holds every owner power. The wedding is
 * hidden at once and can be restored by any owner for the restore window, after
 * which the daily purge hard-deletes it. Refused, writing nothing, while an
 * upgrade payment or a gift checkout can still land, or a change is mid-apply.
 *
 * Its own instance, mounted past the app's `AnyElysia` widening: the organiser
 * chain inside `createApp` is at TypeScript's instantiation-depth limit.
 */
export const createOrganiserWeddingDeleteRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .use(weddingOwner(db))
    .use(rateLimitMiddlewareByUser(limiter))
    .delete(
      "/weddings/:weddingId",
      async ({ weddingId, osnProfileId, request, set }) => {
        // The gate guarantees both; the guard narrows the types.
        if (!weddingId || !osnProfileId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknownEffect(DeleteWeddingBody)(raw);
            const deleted = yield* weddingLifecycleService.softDelete({
              weddingId,
              osnProfileId,
              confirmSlug: body.confirmSlug,
            });
            return {
              deleted: true,
              weddingId: deleted.weddingId,
              restoreUntil: deleted.restoreUntil.toISOString(),
            };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("SchemaError", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "Missing or invalid fields" };
              }),
            ),
            Effect.catchTag("WeddingLifecycleRefused", (err) => refused(set, err.reason)),
            Effect.catchTag("WeddingLifecycleWriteError", () =>
              failed(set, "Could not delete wedding"),
            ),
            Effect.catchDefect(() => failed(set, "Internal error")),
          ),
        );
      },
      manualParse,
    );

/**
 * POST /api/organiser/weddings/:weddingId/restore — any owner restores a
 * soft-deleted wedding inside the restore window. No body.
 *
 * The only organiser route that reaches a deleted wedding, through its own
 * gate. 409 `not_deleted` for a live wedding, 409 `restore_window_passed` once
 * the window has closed, 404 once the purge has run.
 */
export const createOrganiserWeddingRestoreRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .use(weddingOwnerIncludingDeleted(db))
    .use(rateLimitMiddlewareByUser(limiter))
    .post("/weddings/:weddingId/restore", ({ weddingId, osnProfileId, set }) => {
      if (!weddingId || !osnProfileId) {
        set.status = 500;
        return { error: "Internal error" };
      }
      return runCire(
        weddingLifecycleService.restore({ weddingId, osnProfileId }).pipe(
          Effect.map((r) => ({ restored: true, weddingId: r.weddingId })),
          Effect.provideService(DbService, db),
          Effect.catchTag("WeddingLifecycleRefused", (err) => refused(set, err.reason)),
          Effect.catchTag("WeddingLifecycleWriteError", () =>
            failed(set, "Could not restore wedding"),
          ),
          Effect.catchDefect(() => failed(set, "Internal error")),
        ),
      );
    });
