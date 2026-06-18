import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { CreateWeddingBody, RemintBody } from "../schemas/wedding";
import { claimService } from "../services/claim";
import { hostCodeService } from "../services/host-code";
import { markSharedService } from "../services/mark-shared";
import { regenerateCodeService } from "../services/regenerate-code";
import { remintCodesService } from "../services/remint-codes";
import { weddingsService } from "../services/weddings";

// Sentinel parse hook: stops Elysia from consuming the body so the handler can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error. Same idiom as the import routes.
const manualParse = { parse: () => ({}) };

/**
 * Wedding-scoped organiser routes, mounted under /api/organiser. osnAuth()
 * gates every route in this instance (osnProfileId derived on every request).
 *
 * The per-wedding subtree splits by authorisation level:
 *  - DASHBOARD READS (`/guests`, `/events`) use `weddingMember()` — owner OR
 *    co-host. Co-hosts get the read dashboard, nothing destructive.
 *  - DESTRUCTIVE actions (`regenerate-code`) use `weddingOwner()` — owner only.
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
        weddingsService.listForMember(osnProfileId).pipe(
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
    // Dashboard reads — owner OR co-host (weddingMember).
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .get("/guests", ({ weddingId, set }) => {
          // weddingMember() always derives this; the guard keeps a future
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
    )
    // Destructive — owner only (weddingOwner).
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
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
            const wedding = yield* weddingsService.createForOwner(
              osnProfileId,
              body.displayName,
              body.codeStyle,
            );
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

/**
 * Bulk claim-code re-mint onto a new style (C3) + per-family "mark shared"
 * (the Copy-message button). Both are owner-only (weddingOwner) and split into
 * their own instance behind a per-IP limiter so the destructive bulk-write +
 * the high-frequency mark-shared writes don't sit behind (or gate) the
 * dashboard reads. Same sibling-instance pattern as the preview + create routes.
 */
export const createOrganiserRemintRoutes = (
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
        // C3: flip the wedding's code style + rotate EVERY guest family's code
        // onto it, clearing each family's shared marker + revoking its sessions,
        // atomically. Destructive: any already-shared code is invalidated.
        // weddingOwner() proved ownership; the service only touches rows scoped
        // to :weddingId.
        .post(
          "/remint",
          async ({ weddingId, request, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(RemintBody)(raw);
                return yield* remintCodesService.remint(weddingId, body.codeStyle);
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.map((r) => ({ codeStyle: r.codeStyle, reminted: r.reminted })),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("WeddingNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "wedding_not_found" };
                  }),
                ),
                Effect.catchTag("RemintWriteError", () =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Could not re-mint codes" };
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
        )
        // Mark a family's invite code as "shared" — best-effort, fired by the
        // Copy-message button. Bodiless. 404 if the family isn't in :weddingId.
        .post("/families/:familyId/mark-shared", ({ weddingId, params, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            markSharedService.markShared(weddingId, params.familyId).pipe(
              Effect.provideService(DbService, db),
              Effect.map((r) => ({ familyId: r.familyId, codeSharedAt: r.codeSharedAt })),
              Effect.catchTag("FamilyNotInWedding", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "family_not_found" };
                }),
              ),
              Effect.catchTag("MarkSharedWriteError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Could not mark shared" };
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
