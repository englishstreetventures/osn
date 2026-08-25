import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { sessionAuth } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { ClaimItemBody } from "../schemas/registry";
import { versionFromKey } from "../services/event-image";
import { AssetsR2Service, REGISTRY_IMAGE_NAME } from "../services/invite-assets";
import type { AssetsBucket } from "../services/invite-assets";
import {
  negotiateFormat,
  resolveVariant,
  serveTransformedImage,
} from "../services/invite-image-transform";
import type { ImagesBindingLike } from "../services/invite-image-transform";
import { registryGuestService, registryService } from "../services/registry";

// Sentinel parse hook — the handler parses by hand so a malformed payload
// degrades to the schema's 400 (same idiom as every other cire write route).
const manualParse = { parse: () => ({}) };

/**
 * The ONE 404 the whole guest surface answers with.
 *
 * Unknown slug, wedding without the `registry` entitlement, registry never
 * opened, registry unpublished, a household of ANOTHER wedding, an image name
 * that doesn't match the registry prefix, an object missing from R2 — all of
 * them, on every route here, produce this exact body. The image route is
 * genuinely public, and the rest are reachable by anyone holding any valid
 * `cire_session`; an answer that told these apart would let either enumerate
 * which weddings exist and which of them are quietly drafting a gift list.
 */
const notVisible = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "registry_not_found" };
  });

function notVisibleSync(set: { status?: number | string }) {
  set.status = 404;
  return { error: "registry_not_found" };
}

const itemNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "registry_item_not_found" };
  });

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function unauthorisedSync(set: { status?: number | string }) {
  set.status = 401;
  return { error: "Unauthorized" };
}

/**
 * Log a defect before it becomes an anonymous 500.
 *
 * Annotated with NOTHING. The organiser routes annotate `weddingId`, which these
 * handlers don't have until after the read that may be the very thing failing;
 * the identifier they DO have is the slug, and a slug is the couple's names
 * (`anna-and-ben`) — squarely the PII the logging rules keep out of log lines.
 * `runCire` still stamps the trace/span, which is what correlates the line.
 */
const logDefect = (cause: unknown) => Effect.logError("registry guest handler defect", cause);

/**
 * Guest registry — THE LIST, mounted under /api/invite:
 *
 *   GET /api/invite/:slug/registry  (sessionAuth)
 *
 * **The list is not public.** It names what a couple want and what it costs,
 * and they only ever showed it to the people they invited — so it sits behind
 * the same `cire_session` the rest of the invitation does. A visitor with no
 * claim gets 401 and the guest site sends them to the invitation to enter their
 * code; a household of ANOTHER wedding gets the same 404 as an unpublished one
 * (`registryGuestService.guestView` checks the family against the wedding, so
 * one leaked code cannot open every couple's list).
 *
 * Its own instance, and not merged into the `…/mine` one below, for the reason
 * that split exists: the writes carry a limiter this read must not, and the
 * entitlement gate must cover every registry route without ever leaking onto
 * the invite's own public routes.
 */
export const createRegistryGuestListRoutes = (db: Db) =>
  new Elysia({ prefix: "/api/invite" })
    .use(sessionAuth(db))
    .get("/:slug/registry", ({ params, familyId, set }) => {
      // The sessionAuth plugin guarantees this; the check is a runtime net.
      if (!familyId) return unauthorisedSync(set);
      // Same reasoning as the invite payload it sits beside: this JSON carries
      // live claim totals and the couple's copy, and a guest revalidates it on
      // mount. Served stale it would show a gift as available that someone
      // claimed an hour ago — two households buying the same pan.
      set.headers["cache-control"] = "no-store";
      return runCire(
        registryGuestService.guestView({ slug: params.slug, familyId }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("RegistryNotVisible", () => notVisible(set)),
          Effect.tapDefect(logDefect),
          Effect.catchAllDefect(() => internal(set)),
        ),
      );
    });

/**
 * Guest registry — GIFT IMAGE BYTES, mounted under /api/invite:
 *
 *   GET /api/invite/:slug/registry/image/:name  (no auth)
 *
 * **Deliberately still unauthenticated, though the list above is not.** A name
 * is `registry-<uuid>`, minted per save and reachable only from the list, so
 * the bytes are not enumerable without the very read the session now gates —
 * while authenticating them would put a session lookup on every image request
 * on the page, the one place on the guest surface where requests come in
 * dozens. If the couple's pictures ever become sensitive on their own, this is
 * the route to move, and `visibility: "public"` below is the line to change
 * with it.
 */
export const createRegistryGuestImageRoutes = (
  db: Db,
  deps: { readonly assets?: AssetsBucket; readonly images?: ImagesBindingLike } = {},
) =>
  new Elysia({ prefix: "/api/invite" }).get(
    "/:slug/registry/image/:name",
    ({ params, query, request, set }) => {
      if (!REGISTRY_IMAGE_NAME.test(params.name)) return notVisibleSync(set);
      // Bounded, allowlisted variant (?variant=) + Accept-negotiated format,
      // both collapsing to a fixed value, so the transform-URL cardinality per
      // image stays capped (3 variants × 3 formats) — the same cost guarantee
      // the invite image routes make.
      const variant = resolveVariant((query as Record<string, string | undefined>).variant);
      const format = negotiateFormat(request.headers.get("accept"));
      return runCire(
        Effect.gen(function* () {
          // The gate runs BEFORE any R2 or Images work: an unpublished or
          // unentitled wedding must not be able to spend a transform call, and
          // its image bytes must not be reachable by anyone who guesses a name.
          const weddingId = yield* registryGuestService.visibleWeddingId(params.slug);
          // The key is rebuilt server-side from the resolved wedding id and a
          // `:name` that must match `registry-<uuid>` — so no request can name
          // another wedding's object, climb out of the prefix, or reach the
          // invite builder's slots, however it spells the path.
          const key = `assets/${weddingId}/${params.name}`;
          return yield* serveTransformedImage({
            request,
            key,
            // Server-derived version, NEVER the client's `?v=` (S-M1). Every
            // save mints a fresh uuid, so the key IS the content version; keying
            // on `?v=` would let anyone loop ?v=1,2,3… on a public slug to mint
            // unbounded per-call-billed transforms.
            version: versionFromKey(key),
            // Slug-namespaced, and including the image name. The name is what
            // stops every gift in a wedding sharing one cache path (told apart
            // only by a 32-bit hash); the slug prefix is what stops this PUBLIC
            // entry ever colliding with the organiser route's PRIVATE one for
            // the same bytes — `serveTransformedImage` folds `visibility` into
            // the response header, not into the cache key.
            cacheSlot: `${params.slug}:registry:${params.name}`,
            variant,
            format,
            // Public, and the one part of the gift surface that still is —
            // see the route header above for why the uuid name is the gate.
            visibility: "public",
            images: deps.images,
          });
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.provideService(AssetsR2Service, deps.assets as AssetsBucket),
          Effect.catchTag("RegistryNotVisible", () => notVisible(set)),
          // A key absent from R2 is a stale reference, not a fault: the item's
          // row outlived its object (or never had one).
          Effect.catchTag("AssetR2Error", () => notVisible(set)),
          Effect.tapDefect(logDefect),
          Effect.catchAllDefect(() => internal(set)),
        ),
      );
    },
  );

/**
 * Guest registry — THIS HOUSEHOLD'S READ:
 *
 *   GET /api/invite/:slug/registry/mine  (sessionAuth)
 *
 * Split from the writes below because the gate differs by one plugin: reading
 * your own claims is what the gift page does on every mount, and putting it
 * behind the write limiter would 429 a NAT'd household for browsing.
 */
export const createRegistryGuestMineRoutes = (db: Db) =>
  new Elysia({ prefix: "/api/invite" })
    .use(sessionAuth(db))
    .get("/:slug/registry/mine", ({ params, familyId, set }) => {
      // The sessionAuth plugin guarantees this; the check is a runtime net.
      if (!familyId) return unauthorisedSync(set);
      set.headers["cache-control"] = "no-store";
      return runCire(
        registryGuestService.householdView({ slug: params.slug, familyId }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("RegistryNotVisible", () => notVisible(set)),
          Effect.tapDefect(logDefect),
          Effect.catchAllDefect(() => internal(set)),
        ),
      );
    });

/** Options for {@link createRegistryGuestClaimRoutes}. */
export interface RegistryGuestClaimDeps {
  /** Per-IP limiter for the two guest writes. Required. */
  readonly limiter: RateLimiterBackend;
}

/**
 * Guest registry — WRITES:
 *
 *   POST   /api/invite/:slug/registry/items/:itemId/claim   (sessionAuth + limiter)
 *   DELETE /api/invite/:slug/registry/items/:itemId/claim   (sessionAuth + limiter)
 *
 * Gate order: `sessionAuth` (401) → limiter (429). The limiter is LAST of the
 * two so an anonymous caller cannot spend a household's budget by hammering the
 * route. The visible-registry gate necessarily runs inside the handler — it
 * needs a slug→wedding read the middleware chain has no place for — so an
 * authenticated guest of an unpublished wedding does spend their OWN per-IP
 * budget on a 404. That is the intended shape: the budget is per-IP, so the only
 * caller they can exhaust is themselves.
 *
 * Per-IP, unlike the organiser registry writes, which are per-user: a guest has
 * no user. Sized for a household deciding on gifts, not for a form submit.
 *
 * No Turnstile. The `cire_session` cookie these routes require was minted by
 * `POST /api/claim`, which IS Turnstile-gated — the same argument `app.ts`
 * already records for the RSVP writes.
 *
 * There is deliberately NO "mark purchased" endpoint. A claim and a purchase are
 * the same unique `(item_id, family_id)` row in two states, so marking one
 * purchased is a POST with `status: "purchased"` — a second endpoint would be a
 * second way to write one row, and the two would drift.
 *
 * Error mapping, all as machine-readable codes (the `rsvp_closed` precedent):
 *
 *   RegistryNotVisible      → 404 `registry_not_found`
 *   FamilyNotInWedding      → 404 `registry_not_found`       (see below)
 *   RegistryItemNotInWedding→ 404 `registry_item_not_found`
 *   ItemFullyClaimed        → 409 `item_fully_claimed`
 *   InvalidQuantity         → 400 `invalid_quantity`
 *
 * `FamilyNotInWedding` answers as `registry_not_found` — the SAME code an
 * unpublished or unentitled registry gives (S-M1). It fires when a cookie for
 * wedding A is used on wedding B's slug, and the service checks it BEFORE the
 * item, so a holder of any valid cookie learns neither whether that wedding has
 * a list nor whether the item id they guessed exists on it. Answering a
 * distinct item-shaped code told them the second; answering it only when the
 * registry happened to be visible told them the first.
 */
export const createRegistryGuestClaimRoutes = (db: Db, deps: RegistryGuestClaimDeps) =>
  new Elysia({ prefix: "/api/invite" })
    .use(sessionAuth(db))
    .use(rateLimitMiddleware(deps.limiter))
    .post(
      "/:slug/registry/items/:itemId/claim",
      async ({ params, familyId, request, set }) => {
        if (!familyId) return unauthorisedSync(set);
        const raw: unknown = await request.json().catch(() => null);
        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknown(ClaimItemBody)(raw);
            // Resolve the wedding from the SLUG and hand THAT id to the service.
            // The cookie names a household, not a wedding, so this is what stops
            // a family of wedding A acting on wedding B: `claim` proves the
            // family belongs to the wedding it was given, and fails
            // `FamilyNotInWedding` when it doesn't.
            const weddingId = yield* registryGuestService.visibleWeddingId(params.slug);
            yield* registryService.claim({
              weddingId,
              itemId: params.itemId,
              familyId,
              quantity: body.quantity,
              status: body.status,
              note: body.note,
              displayName: body.displayName,
            });
            return { ok: true };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("ParseError", () => badRequest(set)),
            Effect.catchTag("RegistryNotVisible", () => notVisible(set)),
            Effect.catchTag("RegistryItemNotInWedding", () => itemNotFound(set)),
            Effect.catchTag("FamilyNotInWedding", () => notVisible(set)),
            Effect.catchTag("ItemFullyClaimed", () =>
              Effect.sync(() => {
                set.status = 409;
                return { error: "item_fully_claimed" };
              }),
            ),
            // Unreachable through this route — the schema bounds quantity to
            // 1..99 before the service sees it — but mapped rather than cast, so
            // a future schema change can only widen the 400, never 500.
            Effect.catchTag("InvalidQuantity", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "invalid_quantity" };
              }),
            ),
            Effect.tapDefect(logDefect),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      },
      manualParse,
    )
    .delete("/:slug/registry/items/:itemId/claim", ({ params, familyId, set }) => {
      if (!familyId) return unauthorisedSync(set);
      return runCire(
        Effect.gen(function* () {
          const weddingId = yield* registryGuestService.visibleWeddingId(params.slug);
          // A release is a tombstone, not a delete: the row survives as
          // `released` so a re-claim reuses it under the unique index. Scoped by
          // all three ids, so releasing is as cross-tenant-safe as claiming.
          yield* registryService.releaseClaim({ weddingId, itemId: params.itemId, familyId });
          return { ok: true };
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("RegistryNotVisible", () => notVisible(set)),
          Effect.catchTag("FamilyNotInWedding", () => notVisible(set)),
          Effect.catchTag("RegistryItemNotInWedding", () => itemNotFound(set)),
          Effect.tapDefect(logDefect),
          Effect.catchAllDefect(() => internal(set)),
        ),
      );
    });
