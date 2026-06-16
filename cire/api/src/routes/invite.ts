import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { InviteTextBody, isInviteImageSlot } from "../schemas/invite";
import { inviteService } from "../services/invite";
import {
  AssetsR2Service,
  detectImageType,
  fetchAsset,
  MAX_IMAGE_BYTES,
} from "../services/invite-assets";
import type { AssetsBucket } from "../services/invite-assets";

// Sentinel parse hook: stop Elysia consuming the body so handlers parse it by
// hand (JSON for text, raw bytes for images) — matches the import route.
const manualParse = { parse: () => ({}) };

/**
 * Public invite routes (no auth), mounted under /api/invite. Kept in a sibling
 * instance with no `osnAuth` so a guest with no OSN token can render the invite
 * — same split as /api/rsvp and the account-link reads.
 *
 *   GET /api/invite/:slug              → text + image URLs for the guest site
 *   GET /api/invite/:slug/image/:slot  → image bytes (served from R2)
 */
export const createInvitePublicRoutes = (db: Db, assets: AssetsBucket | undefined) =>
  new Elysia({ prefix: "/api/invite" })
    .get("/:slug", ({ params, set }) =>
      Effect.runPromise(
        inviteService.getForSlug(params.slug).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("WeddingNotFound", () =>
            Effect.sync(() => {
              set.status = 404;
              return { error: "Not found" };
            }),
          ),
          Effect.catchAllDefect(() =>
            Effect.sync(() => {
              set.status = 500;
              return { error: "Internal error" };
            }),
          ),
        ),
      ),
    )
    .get("/:slug/image/:slot", ({ params, set }) => {
      if (!isInviteImageSlot(params.slot)) {
        set.status = 404;
        return { error: "Not found" };
      }
      const slot = params.slot;
      return Effect.runPromise(
        Effect.gen(function* () {
          const key = yield* inviteService.imageKeyForSlug(params.slug, slot);
          if (!key) {
            set.status = 404;
            return { error: "Not found" };
          }
          const asset = yield* fetchAsset(key);
          return new Response(asset.bytes, {
            headers: {
              "Content-Type": asset.contentType,
              // Bytes are magic-byte sniffed + allowlisted to JPEG/PNG/WebP on
              // upload, but pin the declared type so a browser can't be coaxed
              // into interpreting the response as anything else (IB-S-M1).
              "X-Content-Type-Options": "nosniff",
              // URL is cache-busted by ?v=<updatedAt>, so a hit is safe to pin.
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.provideService(AssetsR2Service, assets as AssetsBucket),
          Effect.catchTag("WeddingNotFound", () =>
            Effect.sync(() => {
              set.status = 404;
              return { error: "Not found" };
            }),
          ),
          Effect.catchTag("AssetR2Error", () =>
            Effect.sync(() => {
              set.status = 404;
              return { error: "Not found" };
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
    });

/**
 * Organiser invite-builder routes, a sibling instance under /api/organiser.
 * osnAuth() gates every request; weddingOwner() additionally gates the
 * per-wedding subtree (404 unknown wedding, 403 non-owner — never 401, which
 * would make @osn/client discard a valid session).
 *
 *   GET    /weddings/:weddingId/invite             → current customisation
 *   PUT    /weddings/:weddingId/invite/text        → text overrides
 *   POST   /weddings/:weddingId/invite/image/:slot → upload an image
 *   DELETE /weddings/:weddingId/invite/image/:slot → reset slot to default
 */
export const createInviteOrganiserRoutes = (
  db: Db,
  assets: AssetsBucket | undefined,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    // Per-IP cap on invite writes (IB-S-L1) — runs before auth so it also blunts
    // unauthenticated hammering of the surface.
    .use(rateLimitMiddleware(limiter))
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .get("/invite", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return Effect.runPromise(
            inviteService.getForWeddingId(weddingId).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("WeddingNotFound", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Not found" };
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
        })
        .put(
          "/invite/text",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return Effect.runPromise(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(InviteTextBody)(raw);
                yield* inviteService.upsertText(weddingId, body);
                return yield* inviteService.getForWeddingId(weddingId);
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("WeddingNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "Not found" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite text save failed", { weddingId });
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .post(
          "/invite/image/:slot",
          async ({ request, params, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            if (!isInviteImageSlot(params.slot)) {
              set.status = 400;
              return { error: "Unknown image slot" };
            }
            const slot = params.slot;

            // Reject oversized uploads before reading the body (a CDN may strip
            // Content-Length, so the post-read byte check below is the real cap).
            const declared = request.headers.get("content-length");
            if (declared) {
              const n = Number.parseInt(declared, 10);
              if (Number.isFinite(n) && n > MAX_IMAGE_BYTES) {
                set.status = 413;
                return { error: "Image too large (max 5MB)" };
              }
            }

            const bytes = await request.arrayBuffer().catch(() => null);
            if (!bytes) {
              set.status = 400;
              return { error: "Missing image body" };
            }
            if (bytes.byteLength === 0) {
              set.status = 400;
              return { error: "Empty image body" };
            }
            if (bytes.byteLength > MAX_IMAGE_BYTES) {
              set.status = 413;
              return { error: "Image too large (max 5MB)" };
            }

            // Trust the bytes, not the declared Content-Type.
            const contentType = detectImageType(bytes);
            if (!contentType) {
              set.status = 415;
              return { error: "Unsupported image type (use JPEG, PNG, or WebP)" };
            }

            return Effect.runPromise(
              Effect.gen(function* () {
                const slug = yield* inviteService.weddingSlug(weddingId);
                const imageUrl = yield* inviteService.setImage(
                  weddingId,
                  slug,
                  slot,
                  bytes,
                  contentType,
                );
                return { slot, imageUrl };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.provideService(AssetsR2Service, assets as AssetsBucket),
                Effect.catchTag("WeddingNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "Not found" };
                  }),
                ),
                Effect.catchTag("AssetR2Error", () =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite image store failed", { weddingId });
                    set.status = 500;
                    return { error: "Storage error" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite image upload failed", { weddingId });
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .delete("/invite/image/:slot", ({ params, weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          if (!isInviteImageSlot(params.slot)) {
            set.status = 400;
            return { error: "Unknown image slot" };
          }
          const slot = params.slot;
          return Effect.runPromise(
            Effect.gen(function* () {
              yield* inviteService.removeImage(weddingId, slot);
              return yield* inviteService.getForWeddingId(weddingId);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.provideService(AssetsR2Service, assets as AssetsBucket),
              Effect.catchTag("WeddingNotFound", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Not found" };
                }),
              ),
              Effect.catchAllDefect(() =>
                Effect.gen(function* () {
                  yield* Effect.logError("invite image remove failed", { weddingId });
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );
