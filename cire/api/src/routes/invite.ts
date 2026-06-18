import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { getWaitUntil } from "../lib/execution-ctx";
import { metricImageTransform } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { InviteTextBody, InviteThemeBody, isInviteImageSlot } from "../schemas/invite";
import { inviteService } from "../services/invite";
import {
  AssetsR2Service,
  detectImageType,
  fetchAsset,
  MAX_IMAGE_BYTES,
} from "../services/invite-assets";
import type { AssetsBucket, StoredAsset } from "../services/invite-assets";
import {
  buildTransformCacheKey,
  negotiateFormat,
  resolveVariant,
  transformAsset,
} from "../services/invite-image-transform";
import type { ImagesBindingLike } from "../services/invite-image-transform";

// Sentinel parse hook: stop Elysia consuming the body so handlers parse it by
// hand (JSON for text, raw bytes for images) — matches the import route.
const manualParse = { parse: () => ({}) };

/**
 * Public invite routes (no auth), mounted under /api/invite. Kept in a sibling
 * instance with no `osnAuth` so a guest with no OSN token can render the invite
 * — same split as /api/rsvp and the account-link reads.
 *
 *   GET /api/invite/:slug              → text + image URLs for the guest site
 *   GET /api/invite/:slug/image/:slot  → optimised image bytes (R2 + Images)
 *
 * `images` is the Cloudflare Images binding. When present the serve route
 * transforms the R2 original into the requested responsive variant + a
 * negotiated modern format; when absent (local/dev/tests, or an account without
 * the Images product) — or when a transform fails — it serves the raw R2 bytes
 * (the original behaviour), so the route never 500s on a transform miss.
 */
export const createInvitePublicRoutes = (
  db: Db,
  assets: AssetsBucket | undefined,
  images?: ImagesBindingLike,
) =>
  new Elysia({ prefix: "/api/invite" })
    .get("/:slug", ({ params, set }) => {
      // Personalised, edit-sensitive payload (hero image URL + theme + copy).
      // It must never be served stale, or organiser edits won't surface on the
      // guest invite's on-mount revalidation. The image *bytes* stay immutable
      // (their URL is version-busted via updatedAt), but this JSON that hands
      // out those URLs is no-store.
      set.headers["cache-control"] = "no-store";
      return runCire(
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
      );
    })
    .get("/:slug/image/:slot", ({ params, query, request, set }) => {
      if (!isInviteImageSlot(params.slot)) {
        set.status = 404;
        return { error: "Not found" };
      }
      const slot = params.slot;
      // Bounded, allowlisted variant (?variant=) + Accept-negotiated output
      // format. Both collapse to a fixed value, so the transform-URL/format
      // cardinality per slot is capped (3 variants × 3 formats) — keeps the edge
      // cache hot and denies an attacker unbounded distinct transform URLs.
      // (The client's `?v=` is intentionally NOT read here — the cache version is
      // derived server-side from the wedding row's `updatedAt` below, S-M1.)
      const variant = resolveVariant((query as Record<string, string | undefined>).variant);
      const format = negotiateFormat(request.headers.get("accept"));
      return runCire(
        Effect.gen(function* () {
          // Resolve the slug → image key + authoritative content version FIRST.
          // This is a cheap, indexed D1 read and it's required before we can key
          // the cache: the cache-key version is derived SERVER-SIDE from the
          // row's `updatedAt` (NOT the client `?v=`). Slugs are public, so if we
          // keyed on the raw `?v=` an attacker could loop ?v=1,2,3… on a valid
          // slug to force unbounded cache-missing, per-call-billed transforms,
          // defeating the bounded-cardinality cost guarantee (S-M1). The client
          // may still SEND `?v=` (the frontend uses it for browser-cache busting
          // and it equals `updatedAt` anyway) but it MUST NOT influence this key.
          // By design this DB read now runs on EVERY request — it's cheap and is
          // the source of the authoritative version; the expensive work (R2 read
          // + Images binding call) is still skipped on a cache hit below.
          const { key, updatedAt } = yield* inviteService.imageKeyForSlug(params.slug, slot);
          if (!key) {
            set.status = 404;
            return { error: "Not found" };
          }
          // Server-derived version: the row's `updatedAt` epoch ms. A re-upload
          // bumps `updatedAt`, which mints a new cache key (fresh entry) so the
          // new image is never served stale from the old entry.
          const version = updatedAt ? String(updatedAt.getTime()) : undefined;

          // Cache API short-circuit. The Images binding bills per call with no
          // per-unique dedupe, so a fresh guest/device would otherwise re-bill
          // the same transform on every request. We key on slug+slot+variant+
          // format (+ the server content version) — the format is baked into the
          // key because it's Accept-negotiated, not in the request URL — so each
          // negotiated output is a distinct entry. A hit serves the transformed
          // bytes WITHOUT touching the binding (R2 read + transform skipped).
          // `caches` is undefined in unit tests / non-Workers runtimes, so guard.
          const cache =
            typeof caches !== "undefined" && caches.default ? caches.default : undefined;
          const cacheKey = cache
            ? buildTransformCacheKey({ slug: params.slug, slot, variant, format, version })
            : undefined;
          if (cache && cacheKey) {
            const hit = yield* Effect.promise(() => cache.match(cacheKey));
            if (hit) {
              metricImageTransform("cache_hit", variant, format);
              return hit;
            }
          }

          const original = yield* fetchAsset(key);

          // Transform through the Images binding when present; on any failure
          // (or when the binding is absent) fall back to the raw R2 original —
          // never 500 on a transform miss. The metric records which path ran.
          let served: StoredAsset = original;
          if (images) {
            served = yield* transformAsset(images, original, variant, format).pipe(
              Effect.tap(() =>
                Effect.sync(() => metricImageTransform("transformed", variant, format)),
              ),
              Effect.catchTag("ImageTransformError", (err) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning("invite image transform failed; serving original", {
                    slot,
                    variant,
                    format,
                    reason: err.reason,
                  });
                  metricImageTransform("original", variant, format);
                  return original;
                }),
              ),
            );
          } else {
            metricImageTransform("original", variant, format);
          }

          const response = new Response(served.bytes, {
            headers: {
              "Content-Type": served.contentType,
              // Bytes are magic-byte sniffed + allowlisted to JPEG/PNG/WebP on
              // upload, but pin the declared type so a browser can't be coaxed
              // into interpreting the response as anything else (IB-S-M1).
              "X-Content-Type-Options": "nosniff",
              // URL is cache-busted by ?v=<updatedAt>, so a hit is safe to pin.
              "Cache-Control": "public, max-age=31536000, immutable",
              // The chosen output format depends on the request Accept header, so
              // a shared cache must key on it — otherwise an AVIF response could
              // be served to a JPEG-only client (or vice versa). The Cache API
              // key bakes the format in too, but keep Vary for any intermediary
              // (and browser) cache that keys on the raw URL.
              Vary: "Accept",
            },
          });

          // Populate the edge cache on a miss so the next identical request skips
          // the binding. Prefer `ctx.waitUntil` (Elysia doesn't forward it, so we
          // bridge it per-request via setExecutionCtx in the Worker fetch); fall
          // back to awaiting the write inline when no execution context is bound
          // (non-Workers runtimes). Cache the clone so the live `response` body
          // stays readable.
          if (cache && cacheKey) {
            const put = cache.put(cacheKey, response.clone());
            const waitUntil = getWaitUntil(request);
            if (waitUntil) {
              waitUntil(put);
            } else {
              yield* Effect.promise(() => put);
            }
          }

          return response;
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
 *   PUT    /weddings/:weddingId/invite/theme       → per-section fonts + colours
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
          return runCire(
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
            return runCire(
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
        .put(
          "/invite/theme",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(InviteThemeBody)(raw);
                yield* inviteService.upsertTheme(weddingId, body);
                return yield* inviteService.getForWeddingId(weddingId);
              }).pipe(
                Effect.provideService(DbService, db),
                // A bad colour (allow-list miss) or unknown font (enum miss) both
                // surface here as a ParseError → 400, never persisted.
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Invalid colour or font" };
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
                    yield* Effect.logError("invite theme save failed", { weddingId });
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

            return runCire(
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
          return runCire(
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
