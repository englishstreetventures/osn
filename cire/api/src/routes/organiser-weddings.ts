import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { claimService } from "../services/claim";
import { hostCodeService } from "../services/host-code";
import { weddingsService } from "../services/weddings";

/**
 * Wedding-scoped organiser routes, mounted under /api/organiser. osnAuth()
 * gates every route in this instance (osnProfileId derived on every request);
 * weddingOwner() additionally gates the per-wedding subtree.
 */
export const createOrganiserWeddingsRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .get("/weddings", ({ osnProfileId, set }) => {
      if (!osnProfileId) {
        set.status = 401;
        return { error: "unauthorised" };
      }
      return runCire(
        weddingsService.listForOwner(osnProfileId).pipe(
          Effect.provideService(DbService, db),
          Effect.map((list) => ({ weddings: list })),
          Effect.catchAllDefect(() =>
            Effect.sync(() => {
              set.status = 500;
              return { error: "Internal error" };
            }),
          ),
        ),
      );
    })
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .get("/guests", ({ weddingId, set }) => {
          // weddingOwner() always derives this; the guard keeps a future
          // remount without the plugin from compiling into an unscoped query.
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            claimService.getAllGuests(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        })
        .get("/events", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            claimService.listEvents(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );

/**
 * Host preview-code provisioning, split into its own instance so the per-IP
 * rate limiter gates only this mutating route (the find-or-create + event-relink
 * amplifier — S-M2) and not the dashboard's read endpoints above. Same
 * osnAuth + weddingOwner ownership gate; same sibling-instance pattern as the
 * account-link POST. The organiser dashboard opens the guest invite with
 * `?code=<publicId>` so the host sees every event.
 */
export const createOrganiserPreviewRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddleware(limiter))
        .post("/preview-code", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            hostCodeService.ensureForWedding(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("HostCodeError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
              Effect.catchAllDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );
