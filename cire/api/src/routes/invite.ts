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
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import {
  ImageCropBody,
  InviteTextBody,
  InviteThemeBody,
  isInviteImageSlot,
} from "../schemas/invite";
import { eventImageService } from "../services/event-image";
import { inviteService } from "../services/invite";
import {
  AssetsR2Service,
  detectImageType,
  fetchAsset,
  fetchAssetStream,
  MAX_IMAGE_BYTES,
} from "../services/invite-assets";
import type { AssetR2Error, AssetsBucket, StoredAsset } from "../services/invite-assets";
import {
  buildTransformCacheKey,
  negotiateFormat,
  resolveVariant,
  transformAsset,
} from "../services/invite-image-transform";
import type {
  ImagesBindingLike,
  ImageVariant,
  OutputFormat,
} from "../services/invite-image-transform";

// Sentinel parse hook: stop Elysia consuming the body so handlers parse it by
// hand (JSON for text, raw bytes for images) — matches the import route.
const manualParse = { parse: () => ({}) };

/** Shared immutable-image response headers for both the transformed + streamed-
 * original serve paths (the bytes are version-busted via the cache key / URL). */
function imageResponseHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
    Vary: "Accept",
  };
}

/**
 * Serve a transformed image given an already-resolved R2 key + server-derived
 * content version. Shared by the wedding-slot (`hero`/`story`) and the per-event
 * serve routes so both get the IDENTICAL Cache-API-short-circuit + Images-binding
 * transform + raw-original fallback pipeline. `cacheSlot` is the slot segment of
 * the Cache API key (e.g. `"hero"` or `"event:<eventId>"`) — every field that
 * changes the transformed bytes is folded into the key, and the version is ALWAYS
 * the server-derived one (NEVER the client `?v=`), preserving the no-arbitrary-
 * cache-minting invariant (S-M1). `blurOverride` is only ever passed for the
 * blurred `hero-bg` variant; event images render sharp (undefined).
 *
 * Returns a `Response`. Requires `DbService` provided by the caller's pipeline
 * (it doesn't read the DB itself, but stays inside the same Effect for span
 * threading) and `AssetsR2Service` for the R2 read. Fails with `AssetR2Error`
 * when the key is missing from R2 (caller maps to 404).
 */
function serveTransformedImage(args: {
  request: Request;
  key: string;
  version: string | undefined;
  cacheSlot: string;
  variant: ImageVariant;
  format: OutputFormat;
  blurOverride?: number;
  images?: ImagesBindingLike;
}): Effect.Effect<Response, AssetR2Error, AssetsR2Service> {
  const { request, key, version, cacheSlot, variant, format, blurOverride, images } = args;
  return Effect.gen(function* () {
    // Cache API short-circuit. The Images binding bills per call with no
    // per-unique dedupe, so a hit serves the transformed bytes WITHOUT touching
    // the binding. `caches` is undefined in unit tests / non-Workers runtimes.
    const cache = typeof caches !== "undefined" && caches.default ? caches.default : undefined;
    const cacheKey = cache
      ? buildTransformCacheKey({
          slug: cacheSlot,
          slot: cacheSlot,
          variant,
          format,
          version,
          blur: blurOverride,
        })
      : undefined;
    if (cache && cacheKey) {
      const hit = yield* Effect.promise(() => cache.match(cacheKey));
      if (hit) {
        metricImageTransform("cache_hit", variant, format);
        return hit;
      }
    }

    let response: Response;
    if (images) {
      // Transform path: the Images binding needs the original BUFFERED (it feeds
      // the bytes through `input()`), so we keep `fetchAsset`. A transform failure
      // falls back to serving those same already-buffered original bytes.
      const original = yield* fetchAsset(key);
      const served: StoredAsset = yield* transformAsset(
        images,
        original,
        variant,
        format,
        blurOverride,
      ).pipe(
        Effect.tap(() => Effect.sync(() => metricImageTransform("transformed", variant, format))),
        Effect.catchTag("ImageTransformError", (err) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("invite image transform failed; serving original", {
              cacheSlot,
              variant,
              format,
              reason: err.reason,
            });
            metricImageTransform("original", variant, format);
            return original;
          }),
        ),
      );
      response = new Response(served.bytes, { headers: imageResponseHeaders(served.contentType) });
    } else {
      // Original-serve path (no Images binding — local/dev/tests, or an account
      // without the Images product): STREAM R2's body straight into the Response
      // instead of buffering the whole (≤5 MB) image in Worker memory (IB-P-I2).
      // `response.clone()` below tees the stream, so the Cache API `put` and the
      // returned body each get an independent copy.
      const streamed = yield* fetchAssetStream(key);
      metricImageTransform("original", variant, format);
      response = new Response(streamed.body, {
        headers: imageResponseHeaders(streamed.contentType),
      });
    }

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
  });
}

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
          const { key, imageVersion, heroBlur } = yield* inviteService.imageKeyForSlug(
            params.slug,
            slot,
          );
          if (!key) {
            set.status = 404;
            return { error: "Not found" };
          }
          // Server-derived IMAGE version (`imagesUpdatedAt`, migration 0029):
          // a re-upload / crop / hero-blur change mints a new cache key (fresh
          // entry) so the new image is never served stale — while copy/colour
          // saves leave it untouched, keeping the transform cache warm (WT-P-I1).
          const version = imageVersion ? String(imageVersion.getTime()) : undefined;

          // Per-wedding hero backdrop blur (migration 0018). It applies ONLY to
          // the blurred `hero-bg` variant of the `hero` slot; every other
          // slot/variant renders sharp and passes no override. Server-derived
          // (read off the row in imageKeyForSlug, NEVER a client query param), so
          // it can be folded into the cache key without letting an attacker mint
          // arbitrary transforms.
          const blurOverride = slot === "hero" && variant === "hero-bg" ? heroBlur : undefined;

          // Identical Cache-API-short-circuit + Images-binding transform + raw-
          // original fallback pipeline as the per-event serve route — see
          // `serveTransformedImage`. The cache version is ALWAYS the server-
          // derived one (here `updatedAt`, NEVER the client `?v=`), so an attacker
          // can't loop arbitrary `?v=` to mint unbounded per-call-billed
          // transforms (S-M1).
          return yield* serveTransformedImage({
            request,
            key,
            version,
            cacheSlot: `${params.slug}:${slot}`,
            variant,
            format,
            blurOverride,
            images,
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
    })
    .get("/:slug/event/:eventId/image", ({ params, query, request, set }) => {
      // Per-event image serve — the events analogue of `/:slug/image/:slot`.
      // Bounded, allowlisted variant (?variant=) + Accept-negotiated format, both
      // collapsing to a fixed value so the transform-URL cardinality stays capped.
      // Event images render SHARP (no blur override). The cache version is derived
      // SERVER-SIDE from the event's R2 key (events have no `updatedAt`), NEVER the
      // client `?v=` — so an attacker can't loop `?v=` to mint unbounded, per-call-
      // billed transforms (S-M1).
      const variant = resolveVariant((query as Record<string, string | undefined>).variant);
      const format = negotiateFormat(request.headers.get("accept"));
      return runCire(
        Effect.gen(function* () {
          // Resolve slug + event id → image key (+ key-derived version) FIRST.
          // The join scopes the event id to the wedding named by the slug, so a
          // cross-wedding event id matches no row → EventNotFound → 404 (no tenant
          // leak). A present event with a null key is a legitimate "no image" → 404.
          const { key, version } = yield* eventImageService.imageKeyForEvent(
            params.slug,
            params.eventId,
          );
          if (!key) {
            set.status = 404;
            return { error: "Not found" };
          }
          return yield* serveTransformedImage({
            request,
            key,
            version: version ?? undefined,
            cacheSlot: `${params.slug}:event:${params.eventId}`,
            variant,
            format,
            images,
          });
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.provideService(AssetsR2Service, assets as AssetsBucket),
          Effect.catchTag("EventNotFound", () =>
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
 * osnAuth() gates every request; weddingMember() additionally gates the
 * per-wedding subtree (404 unknown wedding, 403 for callers who are neither
 * owner nor co-host — never 401, which would make @osn/client discard a valid
 * session). Co-hosts are trusted co-organisers, so they can both view and
 * customise the invite (text, theme, images) just like the owner; the
 * owner-only surface is limited to deleting the wedding and managing the
 * co-host list.
 *
 *   GET    /weddings/:weddingId/invite             → current customisation
 *   PUT    /weddings/:weddingId/invite/text        → text overrides
 *   PUT    /weddings/:weddingId/invite/theme       → per-section fonts + colours
 *   POST   /weddings/:weddingId/invite/image/:slot      → upload an image
 *   DELETE /weddings/:weddingId/invite/image/:slot      → reset slot to default
 *   PUT    /weddings/:weddingId/invite/image/:slot/crop → save/reset a crop rect
 *   POST   /weddings/:weddingId/events/:eventId/image       → upload event image
 *   DELETE /weddings/:weddingId/events/:eventId/image       → remove event image
 *   PUT    /weddings/:weddingId/events/:eventId/image/crop  → save/reset crop rect
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
        .use(weddingMember(db))
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
        })
        // Save (or reset, with `crop: null`) the crop rectangle for a wedding-slot
        // image. The rectangle is validated server-side (each value 0..1, w/h > 0,
        // x+w ≤ 1, y+h ≤ 1) — an out-of-range box is a ParseError → 400, never
        // persisted (it is interpolated into a guest-facing inline style). The
        // save bumps the row's `updatedAt`, so the guest invite's no-store
        // revalidation picks up the new crop.
        .put(
          "/invite/image/:slot/crop",
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
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(ImageCropBody)(raw);
                yield* inviteService.setCrop(weddingId, slot, body.crop);
                return yield* inviteService.getForWeddingId(weddingId);
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Invalid crop rectangle" };
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
                    yield* Effect.logError("invite image crop save failed", { weddingId });
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        // Per-event image upload (one optional image per event; re-upload
        // REPLACES). Same controls as the wedding-slot upload above: weddingMember
        // gate (owner OR co-host), per-IP rate limit, 5 MB cap (declared + post-
        // read), magic-byte JPEG/PNG/WebP sniff. The service additionally checks
        // the event belongs to :weddingId (EventNotFound → 404) so an organiser
        // can't write an image onto another wedding's event.
        .post(
          "/events/:eventId/image",
          async ({ request, params, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const eventId = params.eventId;

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
                const imageUrl = yield* eventImageService.setImage(
                  weddingId,
                  slug,
                  eventId,
                  bytes,
                  contentType,
                );
                return { eventId, imageUrl };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.provideService(AssetsR2Service, assets as AssetsBucket),
                Effect.catchTag("WeddingNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "Not found" };
                  }),
                ),
                Effect.catchTag("EventNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "Not found" };
                  }),
                ),
                Effect.catchTag("AssetR2Error", () =>
                  Effect.gen(function* () {
                    yield* Effect.logError("event image store failed", { weddingId });
                    set.status = 500;
                    return { error: "Storage error" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("event image upload failed", { weddingId });
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
        .delete("/events/:eventId/image", ({ params, weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const eventId = params.eventId;
          return runCire(
            Effect.gen(function* () {
              yield* eventImageService.removeImage(weddingId, eventId);
              return { eventId, imageUrl: null };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.provideService(AssetsR2Service, assets as AssetsBucket),
              Effect.catchTag("EventNotFound", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Not found" };
                }),
              ),
              Effect.catchAllDefect(() =>
                Effect.gen(function* () {
                  yield* Effect.logError("event image remove failed", { weddingId });
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        })
        // Save (or reset, with `crop: null`) the crop rectangle for an event's
        // image. Same validation as the wedding-slot crop route (out-of-range →
        // 400, never persisted). The service additionally checks the event belongs
        // to :weddingId (EventNotFound → 404), so an organiser can't write a crop
        // onto another wedding's event.
        .put(
          "/events/:eventId/image/crop",
          async ({ request, params, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const eventId = params.eventId;
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(ImageCropBody)(raw);
                yield* eventImageService.setCrop(weddingId, eventId, body.crop);
                return { eventId, crop: body.crop };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Invalid crop rectangle" };
                  }),
                ),
                Effect.catchTag("EventNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "Not found" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("event image crop save failed", { weddingId });
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        ),
    );
