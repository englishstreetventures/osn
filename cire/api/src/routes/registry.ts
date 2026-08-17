import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { getWaitUntil } from "../lib/execution-ctx";
import { metricRegistryGift, metricRegistryItemWrite, metricRegistryLinkPreview } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingEntitlement } from "../middleware/wedding-entitlement";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import {
  CreateRegistryItemBody,
  GiftKindSchema,
  RegistryLinkPreviewBody,
  RegistrySaveImageFromUrlBody,
  ReorderRegistryItemsBody,
  SetThankedBody,
  UpdateRegistryItemBody,
  UpdateRegistrySettingsBody,
} from "../schemas/registry";
import { versionFromKey } from "../services/event-image";
import { AssetsR2Service, MAX_IMAGE_BYTES, REGISTRY_IMAGE_NAME } from "../services/invite-assets";
import type { AssetR2Error, AssetsBucket } from "../services/invite-assets";
import {
  negotiateFormat,
  resolveVariant,
  serveTransformedImage,
} from "../services/invite-image-transform";
import type { ImagesBindingLike } from "../services/invite-image-transform";
import { linkPreviewService } from "../services/link-preview";
import type { LinkPreviewOptions } from "../services/link-preview";
import { reapR2Objects } from "../services/r2-cleanup";
import { registryService } from "../services/registry";
import { registryImageService } from "../services/registry-image";
import type { RegistryImageError } from "../services/registry-image";

// Sentinel parse hook — the handler parses by hand so a malformed payload
// degrades to the schema's 400 (same idiom as the other organiser write routes).
const manualParse = { parse: () => ({}) };

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const itemNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "registry_item_not_found" };
  });

const giftNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "registry_gift_not_found" };
  });

const conflict = (set: { status?: number | string }, error: string) =>
  Effect.sync(() => {
    set.status = 409;
    return { error };
  });

const badRequestCode = (set: { status?: number | string }, error: string) =>
  Effect.sync(() => {
    set.status = 400;
    return { error };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}

/**
 * Log a defect before it becomes an anonymous 500 (S-L1). Annotated with the
 * wedding id and NOTHING else — a registry payload carries guest names, gift
 * notes and thank-you text, none of which belongs in a log line.
 */
const logDefect = (weddingId: string) => (cause: unknown) =>
  Effect.logError("registry handler defect", cause).pipe(Effect.annotateLogs({ weddingId }));

/**
 * Reap an orphaned R2 object AFTER the response goes out (P-I1).
 *
 * The organiser deleted a row; the object behind it is bookkeeping they never
 * see. Awaiting the R2 round trip inline puts a network call on the critical
 * path of a request whose work is already done, so hand it to `waitUntil` and
 * answer now. The reaper is already best-effort and logs its own failures, so
 * nothing is lost by not observing the result.
 *
 * `getWaitUntil` returns nothing outside a Worker (unit tests, the local Bun
 * entry), and there the reap runs inline as before — which is also what keeps
 * the existing delete tests able to observe it.
 */
function reapAfterResponse(
  request: Request,
  assets: AssetsBucket | undefined,
  imageKey: string | null,
): Effect.Effect<void> {
  if (!imageKey) return Effect.void;
  const reap = reapR2Objects(assets, "assets", [imageKey]);
  const waitUntil = getWaitUntil(request);
  if (!waitUntil) return reap;
  return Effect.sync(() => waitUntil(Effect.runPromise(reap)));
}

/** `?giftsOffset=` → a non-negative integer. Anything unparseable reads as 0. */
function parseGiftsOffset(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Gift registry — READ surface (platform Phase 4, [[registry]]):
 *
 *   GET /api/organiser/weddings/:weddingId/registry   (weddingMember + entitlement)
 *
 * Split from the write factory so the read gate (weddingMember) never
 * cross-contaminates the write gates — mirrors createBudgetReadRoutes.
 *
 * LOCKED: `weddingEntitlement(db, "registry")` sits after the role gate, and the
 * `registry` entitlement is granted to no wedding, so this answers
 * 402 `payment_required` for every caller today. That is the whole mechanism by
 * which the feature ships built but unreachable — the portal turns the 402 into
 * the upsell panel.
 */
export const createRegistryReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(weddingEntitlement(db, "registry"))
        .get("/registry", async ({ weddingId, query, set }) => {
          if (!weddingId) return internalSync(set);
          // The gift log is paged; the offset is the only knob the client gets.
          // The service clamps it — this only has to turn a string into a number.
          const giftsOffset = parseGiftsOffset((query as Record<string, unknown>)?.giftsOffset);
          return runCire(
            registryService.get(weddingId, { giftsOffset }).pipe(
              Effect.provideService(DbService, db),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        }),
    );

/**
 * Gift registry — WRITE surface:
 *
 *   PUT    /registry/settings                        (weddingEditor)
 *   POST   /registry/items                           (weddingEditor)
 *   PATCH  /registry/items/reorder                   (weddingEditor)
 *   PATCH  /registry/items/:itemId                   (weddingEditor)
 *   DELETE /registry/items/:itemId                   (weddingEditor)
 *   POST   /registry/gifts/:kind/:giftId/thanked     (weddingEditor)
 *
 * A viewer gets 403 `read_only_role`; a wedding without the entitlement gets 402.
 * The service re-scopes every write by wedding_id, so a cross-tenant id 404s.
 *
 * NOTE `/registry/items/reorder` is registered BEFORE `/registry/items/:itemId`
 * so the literal wins over the param.
 *
 * `FamilyNotInWedding` has no mapping here on purpose: it can only come out of
 * `registryService.claim`, which the GUEST surface will call. It gets its 404
 * when that route lands, alongside the claim/release endpoints.
 *
 * Stripe onboarding (`/registry/stripe/*`, weddingOwner — connecting a bank
 * account is an owner action) lands with the Connect work; it is deliberately
 * absent rather than stubbed, so nothing here implies a payment path exists yet.
 *
 * `assets` is the `cire-assets` R2 binding, needed by ONE route: deleting an item
 * orphans the object its `image_key` pointed at, and D1's cascade never reaches
 * R2. Optional, because a deployment without the binding must still be able to
 * delete items — the reaper logs and moves on, and the reconcile sweep
 * (`asset-reconcile.ts`) is the backstop for anything it misses.
 */
export const createRegistryWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  assets?: AssetsBucket,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.guard((write) =>
        write
          .use(weddingEditor(db))
          .use(weddingEntitlement(db, "registry"))
          .put(
            "/registry/settings",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(UpdateRegistrySettingsBody)(raw);
                  // The cash-gifts/Stripe invariant lives in the service (S-M3),
                  // not here: this route used to load the WHOLE snapshot — items,
                  // gift log, currency — to read one boolean off it (P-C2).
                  const settings = yield* registryService.updateSettings(weddingId, body);
                  return { settings };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("StripeNotReady", () => conflict(set, "stripe_not_ready")),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .post(
            "/registry/items",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(CreateRegistryItemBody)(raw);
                  const item = yield* registryService.createItem({ weddingId, ...body });
                  yield* Effect.sync(() => metricRegistryItemWrite("create"));
                  return { item };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("InvalidQuantity", () => badRequest(set)),
                  Effect.catchTag("ImageKeyNotInWedding", () =>
                    badRequestCode(set, "image_key_not_in_wedding"),
                  ),
                  Effect.catchTag("RegistryItemLimitReached", () =>
                    conflict(set, "registry_item_limit_reached"),
                  ),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .patch(
            "/registry/items/reorder",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(ReorderRegistryItemsBody)(raw);
                  yield* registryService.reorderItems(weddingId, body.orderedIds);
                  return { ok: true as const };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .patch(
            "/registry/items/:itemId",
            async ({ weddingId, params, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(UpdateRegistryItemBody)(raw);
                  const item = yield* registryService.updateItem({
                    weddingId,
                    itemId: params.itemId,
                    patch: body,
                  });
                  yield* Effect.sync(() => metricRegistryItemWrite("update"));
                  return { item };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("InvalidQuantity", () => badRequest(set)),
                  Effect.catchTag("ImageKeyNotInWedding", () =>
                    badRequestCode(set, "image_key_not_in_wedding"),
                  ),
                  Effect.catchTag("RegistryItemNotInWedding", () => itemNotFound(set)),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .delete("/registry/items/:itemId", async ({ weddingId, params, request, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              registryService.removeItem(weddingId, params.itemId).pipe(
                Effect.tap(() => Effect.sync(() => metricRegistryItemWrite("remove"))),
                // Nothing else references the object now, so it is an orphan.
                // Reap it rather than leaving it to the 7-day reconcile sweep:
                // the picture came off a shop page or the couple's camera roll,
                // and a bucket with no lifecycle rule keeps it forever.
                // Best-effort by contract — a failed delete logs and never turns
                // a successful delete into an error the organiser has to see.
                //
                // `imageKeyOrphaned` is the service's verdict, taken with the
                // delete: two items may name the same key, and reaping on the
                // first delete would blank the survivor's picture (S-M1).
                Effect.tap(({ imageKey, imageKeyOrphaned }) =>
                  reapAfterResponse(request, assets, imageKeyOrphaned ? imageKey : null),
                ),
                Effect.map(() => ({ ok: true as const })),
                Effect.provideService(DbService, db),
                Effect.catchTag("RegistryItemNotInWedding", () => itemNotFound(set)),
                Effect.tapDefect(logDefect(weddingId)),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          })
          .post(
            "/registry/gifts/:kind/:giftId/thanked",
            async ({ weddingId, params, request, osnProfileId, set }) => {
              if (!weddingId || !osnProfileId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(SetThankedBody)(raw);
                  // The kind comes off the PATH, so it is validated as strictly
                  // as a body field would be — an unknown value must 400, never
                  // fall through to a table by coincidence.
                  const kind = yield* Schema.decodeUnknown(GiftKindSchema)(params.kind);
                  yield* registryService.setThanked({
                    weddingId,
                    kind,
                    giftId: params.giftId,
                    thanked: body.thanked,
                    actorOsnProfileId: osnProfileId,
                  });
                  yield* Effect.sync(() =>
                    metricRegistryGift(body.thanked ? "thanked" : "unthanked"),
                  );
                  return { ok: true as const };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("GiftNotInWedding", () => giftNotFound(set)),
                  Effect.tapDefect(logDefect(weddingId)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          ),
      ),
    );

/** Options for {@link createRegistryLinkPreviewRoutes}. */
export interface RegistryLinkPreviewDeps {
  /** Per-organiser limiter. Required — this route makes an outbound fetch. */
  readonly limiter: RateLimiterBackend;
  /** Test seam: injectable fetch + DNS resolver for the preview service. */
  readonly linkPreviewOptions?: LinkPreviewOptions;
}

/**
 * Gift registry — LINK PREVIEW:
 *
 *   POST /registry/link-preview   (weddingEditor + registry entitlement + limiter)
 *
 * Mounted as its own factory rather than folded into the write routes above,
 * for one reason: it is the only registry endpoint that spends OUR network on a
 * caller's input. One authenticated request costs a full page fetch to a host
 * the organiser named, so it needs a limiter the other writes must not share —
 * and an Elysia guard applies to every route in its group. Same split, same
 * reason, as `routes/organiser-enquiries.ts`.
 *
 * Gate order is the sibling write routes' order with the limiter appended:
 * `osnAuth` (401) → `weddingEditor` (403 `read_only_role`) → `weddingEntitlement`
 * (402 `payment_required`) → limiter (429). The limiter goes LAST so a wedding
 * without the entitlement is turned away before it can spend anyone's budget.
 *
 * Error mapping — every one of these is the caller's or the internet's problem,
 * never ours, so none of them is a 500:
 *
 *   LinkPreviewBlocked        → 400 `blocked_url`
 *   LinkPreviewFetchFailed    → 502 `preview_fetch_failed`
 *   LinkPreviewUnusableContent→ 415 `unsupported_content_type`
 *   LinkPreviewNoImages       → 422 `no_images_found`
 *
 * The blocked response deliberately carries NO reason. `blocked_url` tells the
 * organiser to check their link; telling them *which* rule fired would turn this
 * endpoint into a network scanner with a clean oracle — "private_address" vs
 * "unresolvable" maps our internal ranges one query at a time. The reason is in
 * the log line instead, where only we can read it.
 */
export const createRegistryLinkPreviewRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: RegistryLinkPreviewDeps,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .use(weddingEntitlement(db, "registry"))
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .post(
          "/registry/link-preview",
          async ({ weddingId, request, set }) => {
            if (!weddingId) return internalSync(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(RegistryLinkPreviewBody)(raw);
                const preview = yield* linkPreviewService.preview(
                  body.url,
                  deps.linkPreviewOptions,
                );
                yield* Effect.sync(() => metricRegistryLinkPreview("ok"));
                return {
                  title: preview.title,
                  siteName: preview.siteName,
                  images: preview.imageUrls,
                };
              }).pipe(
                Effect.catchTag("ParseError", () => badRequest(set)),
                Effect.catchTag("LinkPreviewBlocked", () =>
                  Effect.sync(() => metricRegistryLinkPreview("blocked")).pipe(
                    Effect.zipRight(badRequestCode(set, "blocked_url")),
                  ),
                ),
                Effect.catchTag("LinkPreviewFetchFailed", () =>
                  Effect.sync(() => metricRegistryLinkPreview("fetch_failed")).pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        set.status = 502;
                        return { error: "preview_fetch_failed" };
                      }),
                    ),
                  ),
                ),
                Effect.catchTag("LinkPreviewUnusableContent", () =>
                  Effect.sync(() => metricRegistryLinkPreview("unusable_content")).pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        set.status = 415;
                        return { error: "unsupported_content_type" };
                      }),
                    ),
                  ),
                ),
                Effect.catchTag("LinkPreviewNoImages", () =>
                  Effect.sync(() => metricRegistryLinkPreview("no_images")).pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        set.status = 422;
                        return { error: "no_images_found" };
                      }),
                    ),
                  ),
                ),
                Effect.tapDefect(logDefect(weddingId)),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          },
          manualParse,
        ),
    );

/** Options for {@link createRegistryImageRoutes}. */
export interface RegistryImageDeps {
  /** Per-organiser limiter. Required — the from-url leg makes an outbound fetch. */
  readonly limiter: RateLimiterBackend;
  /** `cire-assets` R2 binding. Absent (local dev without R2) ⇒ every save 500s. */
  readonly assets?: AssetsBucket;
  /** Test seam: injectable fetch + DNS resolver for the from-url leg. */
  readonly imageOptions?: LinkPreviewOptions;
}

/**
 * Gift registry — IMAGE SAVES:
 *
 *   POST /registry/image           (weddingEditor + entitlement + limiter)
 *   POST /registry/image/from-url  (weddingEditor + entitlement + limiter)
 *
 * Both end with bytes in R2 and answer with the key the caller then puts in an
 * item's `imageKey` (on create, or on a later patch). They are deliberately NOT
 * scoped to an item id: the add-form has no item yet when the organiser picks a
 * picture, and inventing a draft item to hang bytes off would leave a half-item
 * behind every abandoned form.
 *
 * The from-url leg is the whole point of the link preview: the organiser pastes a
 * shop link, `POST /registry/link-preview` shows what that page offers, they pick
 * one, and THIS route copies the bytes. What is stored is a key, never the URL —
 * see `services/registry-image.ts` for why hotlinking is not an option, and why
 * the picked URL is re-guarded here even though we emitted it.
 *
 * Own factory, same reason the link preview has one: the outbound fetch needs a
 * limiter the other registry writes must not share, and an Elysia guard applies
 * to every route in its group. Gate order copies the sibling writes with the
 * limiter appended: `osnAuth` (401) → `weddingEditor` (403 `read_only_role`) →
 * `weddingEntitlement` (402) → limiter (429).
 *
 * Error mapping mirrors the preview route, including its silence about WHY a URL
 * was blocked — naming the rule would make this a network scanner with a clean
 * oracle. The reason is in the log line, where only we can read it:
 *
 *   RegistryImageBlocked        → 400 `blocked_url`
 *   RegistryImageFetchFailed    → 502 `image_fetch_failed`
 *   RegistryImageUnsupportedType→ 415 `unsupported_image_type`
 *   RegistryImageTooLarge       → 413 `image_too_large`
 */
export const createRegistryImageRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: RegistryImageDeps,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .use(weddingEntitlement(db, "registry"))
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .post(
          "/registry/image",
          async ({ weddingId, request, set }) => {
            if (!weddingId) return internalSync(set);
            // Refuse an over-cap upload before reading the body. A CDN may strip
            // Content-Length and a client may simply lie, so this is a courtesy
            // to honest clients — the real cap is the byte-length check the
            // service runs on what actually arrived.
            const declared = request.headers.get("content-length");
            if (declared) {
              const n = Number.parseInt(declared, 10);
              if (Number.isFinite(n) && n > MAX_IMAGE_BYTES) {
                set.status = 413;
                return { error: "image_too_large" };
              }
            }
            const bytes = await request.arrayBuffer().catch(() => null);
            if (!bytes || bytes.byteLength === 0) {
              set.status = 400;
              return { error: "Missing or invalid fields" };
            }
            return runCire(
              registryImageService
                .storeUpload(weddingId, bytes, request.headers.get("content-type") ?? undefined)
                .pipe(
                  Effect.provideService(AssetsR2Service, deps.assets as AssetsBucket),
                  registryImageErrors(set, weddingId),
                ),
            );
          },
          manualParse,
        )
        .post(
          "/registry/image/from-url",
          async ({ weddingId, request, set }) => {
            if (!weddingId) return internalSync(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(RegistrySaveImageFromUrlBody)(raw);
                return yield* registryImageService.storeFromUrl(
                  weddingId,
                  body.url,
                  deps.imageOptions,
                );
              }).pipe(
                Effect.provideService(AssetsR2Service, deps.assets as AssetsBucket),
                Effect.catchTag("ParseError", () => badRequest(set)),
                registryImageErrors(set, weddingId),
              ),
            );
          },
          manualParse,
        ),
    );

/**
 * Shared tail for both save legs: the four refusals, the storage failure, and
 * the defect net. Written once so the two routes cannot drift into answering
 * different statuses for the same verdict.
 *
 * The upload leg cannot produce `RegistryImageBlocked` or
 * `RegistryImageFetchFailed` (it never leaves the Worker), but both are in the
 * service's error union, so both are handled — a total mapping beats a cast.
 */
function registryImageErrors(set: { status?: number | string }, weddingId: string) {
  return <A>(effect: Effect.Effect<A, RegistryImageError | AssetR2Error, never>) =>
    effect.pipe(
      Effect.catchTag("RegistryImageBlocked", () => badRequestCode(set, "blocked_url")),
      Effect.catchTag("RegistryImageFetchFailed", () =>
        Effect.sync(() => {
          set.status = 502;
          return { error: "image_fetch_failed" };
        }),
      ),
      Effect.catchTag("RegistryImageUnsupportedType", () =>
        Effect.sync(() => {
          set.status = 415;
          return { error: "unsupported_image_type" };
        }),
      ),
      Effect.catchTag("RegistryImageTooLarge", () =>
        Effect.sync(() => {
          set.status = 413;
          return { error: "image_too_large" };
        }),
      ),
      // The service already logged the R2 failure with a bounded annotation; this
      // only turns it into the one status that IS our fault.
      Effect.catchTag("AssetR2Error", () => internal(set)),
      Effect.tapDefect(logDefect(weddingId)),
      Effect.catchAllDefect(() => internal(set)),
    );
}

/**
 * Gift registry — IMAGE SERVE:
 *
 *   GET /registry/image/:name   (weddingMember + entitlement)
 *
 * The organiser portal's thumbnail. Same Cache-API-short-circuit + Images-binding
 * transform + raw-original fallback as every other cire image — `serveTransformedImage`
 * is shared, not re-implemented.
 *
 * Two things make it safe to address an object by name here:
 *
 *  - the KEY IS REBUILT server-side as `assets/<weddingId>/<name>` from the
 *    route's own `:weddingId`, which the role gate has already tied to the
 *    caller, so no request can name another wedding's object however it spells
 *    the path; and
 *  - `:name` must match `registry-<uuid>`, so it cannot climb out of that prefix
 *    or reach the invite builder's slots.
 *
 * `visibility: "private"` — these bytes belong to one couple's portal, so no
 * shared cache may keep a copy. The per-colo Workers cache still applies; that
 * lookup happens after the gates.
 *
 * The version in the cache key is derived from the key itself (`versionFromKey`),
 * never from the client's `?v=`: every save mints a fresh uuid, so the key IS the
 * content version, and an attacker cannot loop `?v=` to mint unbounded per-call-
 * billed transforms (S-M1).
 *
 * A separate factory from the saves above because the gate differs — a viewer
 * co-host may LOOK at the registry (weddingMember) and may not write to it.
 *
 * Guests do not read registry images through this route. When the guest-facing
 * registry lands it needs its own public serve path off the wedding slug, gated
 * by `registry_settings.published` — mounting one route for both audiences would
 * mean an organiser-only gate guarding guest bytes, or no gate at all.
 */
export const createRegistryImageServeRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: { readonly assets?: AssetsBucket; readonly images?: ImagesBindingLike },
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(weddingEntitlement(db, "registry"))
        .get("/registry/image/:name", ({ weddingId, params, query, request, set }) => {
          if (!weddingId) return internalSync(set);
          if (!REGISTRY_IMAGE_NAME.test(params.name)) {
            set.status = 404;
            return { error: "Not found" };
          }
          const key = `assets/${weddingId}/${params.name}`;
          const variant = resolveVariant((query as Record<string, string | undefined>).variant);
          const format = negotiateFormat(request.headers.get("accept"));
          return runCire(
            serveTransformedImage({
              request,
              key,
              version: versionFromKey(key),
              // The image name belongs in the slot, as it does on the invite
              // routes: without it every registry image in a wedding shares one
              // cache path and is told apart only by `versionFromKey`, a 32-bit
              // hash that is not a security primitive and need not be unique.
              cacheSlot: `registry:${weddingId}:${params.name}`,
              variant,
              format,
              visibility: "private",
              images: deps.images,
            }).pipe(
              Effect.provideService(AssetsR2Service, deps.assets as AssetsBucket),
              // A key that is absent from R2 is a stale reference, not a fault:
              // the item's row outlived its object (or never had one).
              Effect.catchTag("AssetR2Error", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Not found" };
                }),
              ),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        }),
    );
