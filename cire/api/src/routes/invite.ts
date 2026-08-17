import { DESIGNS } from "@cire/invite-designs";
import type { DesignMeta } from "@cire/invite-designs";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { parseSessionToken } from "../lib/cookie";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import {
  ImageCropBody,
  InviteDesignBody,
  InviteTextBody,
  InviteThemeBody,
  isInviteImageSlot,
} from "../schemas/invite";
import { entitlementService } from "../services/entitlements";
import { eventImageService } from "../services/event-image";
import { inviteService } from "../services/invite";
import { AssetsR2Service, detectImageType, MAX_IMAGE_BYTES } from "../services/invite-assets";
import type { AssetsBucket } from "../services/invite-assets";
import {
  negotiateFormat,
  resolveVariant,
  serveTransformedImage,
} from "../services/invite-image-transform";
import type { ImagesBindingLike } from "../services/invite-image-transform";
import { sessionService } from "../services/session";

// Sentinel parse hook: stop Elysia consuming the body so handlers parse it by
// hand (JSON for text, raw bytes for images) — matches the import route.
const manualParse = { parse: () => ({}) };

/** Slots whose bytes require a claimed guest session (see `getForSlug`). */
function slotRequiresSession(slot: InviteImageSlot): boolean {
  return slot === "footer";
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

          // Session gate for the closing section's motif. The note beside it is
          // withheld from the public `GET /:slug` (see `getForSlug`) because it
          // is addressed to the invited household; the image has to be held to
          // the same line or the gate is only half a gate — the URL is derivable
          // from the public slug. A valid session must ALSO belong to this
          // wedding, else any guest of any wedding could read this one's motif.
          //
          // 404, not 401/403: an unclaimed visitor should not learn whether a
          // closing image exists, and the route already 404s a slot with no key.
          if (slotRequiresSession(slot)) {
            const token = parseSessionToken(request.headers.get("cookie"));
            const familyId = token
              ? yield* sessionService.validate(token).pipe(
                  Effect.map((session) => session.familyId),
                  Effect.catchTag("SessionInvalid", () => Effect.succeed(null)),
                )
              : null;
            const authorised = familyId
              ? yield* inviteService.sessionOwnsWedding(familyId, params.slug)
              : false;
            if (!authorised) {
              set.status = 404;
              return { error: "Not found" };
            }
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
            visibility: slotRequiresSession(slot) ? "private" : "public",
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
 * osnAuth() gates every request; the per-wedding subtree splits by role (404
 * unknown wedding, 403 for callers who are neither owner nor co-host — never
 * 401, which would make @osn/client discard a valid session):
 *
 *  - the READ (`GET /invite`) sits behind `weddingMember()` — every role,
 *    including viewer co-hosts, can see the current customisation;
 *  - the WRITES (text, theme, images) sit behind `weddingEditor()` — owner or
 *    editor co-host; a viewer gets 403 `read_only_role`.
 *
 * Editor co-hosts are trusted co-organisers (a partner or hired planner), so
 * they customise the invite just like the owner; the owner-only surface is
 * limited to deleting the wedding and managing the co-host list.
 *
 *   GET    /weddings/:weddingId/invite             → current customisation
 *   PUT    /weddings/:weddingId/invite/text        → text overrides
 *   PUT    /weddings/:weddingId/invite/theme       → per-section fonts + colours
 *   PUT    /weddings/:weddingId/invite/design      → which design pack renders
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
  designs: readonly DesignMeta[] = DESIGNS,
) =>
  new Elysia({ prefix: "/api/organiser" })
    // Per-IP cap on invite writes (IB-S-L1) — runs before auth so it also blunts
    // unauthenticated hammering of the surface.
    .use(rateLimitMiddleware(limiter))
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/invite", ({ weddingId, set }) => {
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
      }),
    )
    // Invite WRITES — owner or editor co-host (weddingEditor). Viewers keep the
    // read above; any mutation answers 403 read_only_role.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
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
        // Which design pack the invite renders as. The id must be in the
        // catalog (unknown → 422, so a newer organiser build can't half-save)
        // and a premium tier requires the wedding's `premium_templates`
        // entitlement (403 otherwise — the client greys locked cards out, but
        // the server is the gate).
        .put(
          "/invite/design",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(InviteDesignBody)(raw);
                const design = designs.find((d) => d.id === body.designId);
                if (!design) {
                  set.status = 422;
                  return { error: "Unknown design" };
                }
                if (design.tier === "premium") {
                  const entitled = yield* entitlementService.has(weddingId, "premium_templates");
                  if (!entitled) {
                    set.status = 403;
                    return { error: "premium_design" };
                  }
                }
                yield* inviteService.setDesign(weddingId, design.id);
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
                    yield* Effect.logError("invite design save failed", { weddingId });
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
        //
        // `screen` (optional, default `desktop`) targets the hero's phone
        // rectangle (migration 0046). Only the hero renders at both viewport
        // aspects, so `screen: "mobile"` on any other slot is a 400.
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
                const screen = body.screen ?? "desktop";
                if (screen === "mobile" && slot !== "hero") {
                  set.status = 400;
                  return { error: "Only the hero image has a phone crop" };
                }
                yield* inviteService.setCrop(weddingId, slot, body.crop, screen);
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
        // REPLACES). Same controls as the wedding-slot upload above: weddingEditor
        // gate (owner OR editor co-host), per-IP rate limit, 5 MB cap (declared +
        // post-read), magic-byte JPEG/PNG/WebP sniff. The service additionally checks
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
                // Event images render at a single aspect — only the hero has a
                // phone rectangle (0046), so a mobile-targeted save here is a 400.
                if (body.screen === "mobile") {
                  set.status = 400;
                  return { error: "Only the hero image has a phone crop" };
                }
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
