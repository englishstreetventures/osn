import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { CreateWeddingBody } from "../schemas/wedding";
import { claimService } from "../services/claim";
import { hostCodeService } from "../services/host-code";
import { regenerateCodeService } from "../services/regenerate-code";
import { weddingsService } from "../services/weddings";

// Sentinel parse hook: stops Elysia from consuming the body so the handler can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error. Same idiom as the import routes.
const manualParse = { parse: () => ({}) };

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
        })
        // C2: rotate a family's claim code + revoke its sessions, atomically.
        // weddingOwner() already proved the caller owns :weddingId; the service
        // re-checks family ∈ wedding (404 FamilyNotInWedding otherwise) so an
        // owner of wedding A can't rotate a family under wedding B.
        .post("/families/:familyId/regenerate-code", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            regenerateCodeService.regenerate(weddingId, params.familyId).pipe(
              Effect.provideService(DbService, db),
              Effect.map((r) => ({ familyId: r.familyId, publicId: r.publicId })),
              Effect.catchTags({
                FamilyNotInWedding: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "family_not_found" };
                  }),
                RegenerateWriteError: () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not regenerate code" };
                  }),
              }),
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
 * Create a new wedding owned by the caller, split into its own instance so the
 * per-IP rate limiter (S-L1) gates only this mutating insert and not the
 * `GET /weddings` list above. osnAuth() supplies the owner — the body carries
 * only the display name (slug + id are server-generated). Same sibling-instance
 * pattern as the preview + account-link POSTs.
 */
export const createOrganiserWeddingCreateRoute = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .use(rateLimitMiddleware(limiter))
    .post(
      "/weddings",
      async ({ osnProfileId, request, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }

        const raw: unknown = await request.json().catch(() => null);

        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknown(CreateWeddingBody)(raw);
            const wedding = yield* weddingsService.createForOwner(osnProfileId, body.displayName);
            set.status = 201;
            return { wedding };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("ParseError", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "Missing or invalid fields" };
              }),
            ),
            Effect.catchTag("WeddingCreateError", () =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Could not create wedding" };
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
      },
      manualParse,
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
