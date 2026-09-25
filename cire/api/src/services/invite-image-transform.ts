/**
 * On-the-fly responsive/optimised image transforms for invite assets, run
 * through the Cloudflare Workers Images binding (`env.IMAGES`) against the R2
 * original. The binding is undefined locally (`wrangler dev` / miniflare) and in
 * unit tests, and a transform can fail at the edge — both paths fall back to
 * serving the original bytes (today's behaviour), so this module never 500s on a
 * transform miss. The actual fallback wiring lives in the serve route; here we
 * keep the pure, testable pieces (variant resolution, format negotiation) plus
 * the thin Effect wrapper around the binding.
 */
import { Data, Effect } from "effect";

import { getWaitUntil } from "../lib/execution-ctx";
import { metricImageTransform } from "../metrics";
import { fetchAsset, fetchAssetStream } from "./invite-assets";
import type { AssetR2Error, AssetsR2Service, StoredAsset } from "./invite-assets";

// ── Variant scheme ────────────────────────────────────────────────────────────

/**
 * Bounded, allowlisted set of named variants → fixed render widths. Named (not
 * an arbitrary `?w=`) on purpose: cardinality is exactly four per slot, which
 * keeps the edge cache hot and denies an attacker the ability to mint unbounded
 * distinct transform URLs (a cache-poisoning / cost amplifier). `card` is the
 * default when no/unknown variant is requested — the common in-page size. This
 * union is the single source of truth: it bounds the `?variant=` query param, the
 * `srcset` widths the frontend emits, and the bounded metric/span attribute.
 *
 * `hero-bg` is the sharp hero width (1600) rendered with a server-side blur (see
 * {@link VARIANT_BLUR}) — the soft full-bleed backdrop the hero title sits over.
 * It exists as its OWN variant (rather than a `?blur=` param) so the blur radius
 * stays a server constant and never becomes client-controlled: an attacker can't
 * sweep blur values to mint unbounded transforms, and the sharp `hero` variant
 * (used wherever a crisp full-res hero is wanted) is unaffected.
 */
export const IMAGE_VARIANTS = {
  thumb: 320,
  card: 800,
  hero: 1600,
  "hero-bg": 1600,
} as const;

export type ImageVariant = keyof typeof IMAGE_VARIANTS;

export const DEFAULT_VARIANT: ImageVariant = "card";

/**
 * DEFAULT server-chosen Gaussian blur radius (in Cloudflare Images terms) applied
 * per variant. Only `hero-bg` is blurred — a tasteful "soft backdrop" radius. As
 * of migration 0018 the hero backdrop blur is PER-WEDDING (`hero_blur`, 0–40):
 * this map is now only the fallback the serve route uses when no per-wedding
 * override is resolved. The radius is still server-derived (read off the row or
 * this constant), NEVER request input — an attacker still can't sweep blur values
 * to mint unbounded transforms. Variants absent from this map are served sharp.
 */
export const VARIANT_BLUR = {
  "hero-bg": 28,
} as const satisfies Partial<Record<ImageVariant, number>>;

/**
 * The read side of {@link VARIANT_BLUR}. Named so the lookup can be open —
 * most variants are absent from the table and render sharp.
 */
interface VariantBlurTable {
  readonly [variant: string]: number | undefined;
}

/** The default blur radius for a variant, or `undefined` when it renders sharp. */
export function blurForVariant(variant: ImageVariant): number | undefined {
  const table: VariantBlurTable = VARIANT_BLUR;
  return table[variant];
}

/**
 * Resolve a requested `?v=` value to a known variant. Anything missing or
 * outside the allowlist collapses to {@link DEFAULT_VARIANT} rather than 400 —
 * an unknown variant is a benign "serve the default size", not a client error,
 * and refusing to mint URLs outside the set is what bounds cardinality.
 */
export function resolveVariant(raw: string | null | undefined): ImageVariant {
  if (raw && raw in IMAGE_VARIANTS) return raw as ImageVariant;
  return DEFAULT_VARIANT;
}

// ── Output-format negotiation ─────────────────────────────────────────────────

/** Modern formats we are willing to emit, best→worst, gated on `Accept`. */
export type OutputFormat = "image/avif" | "image/webp" | "image/jpeg";

/**
 * Pick the best output format the client advertises in its `Accept` header,
 * preferring AVIF, then WebP, falling back to JPEG (universally supported). We
 * negotiate ourselves rather than relying on a magic `format: "auto"` so the
 * chosen format is an explicit, bounded value we can put on the metric + span.
 */
export function negotiateFormat(accept: string | null | undefined): OutputFormat {
  const header = accept ?? "";
  if (header.includes("image/avif")) return "image/avif";
  if (header.includes("image/webp")) return "image/webp";
  return "image/jpeg";
}

// ── Cache key ─────────────────────────────────────────────────────────────────

/**
 * Build the canonical Cache API key URL for a transformed serve. The Workers
 * Images binding bills per call with no per-unique dedupe, so we short-circuit
 * with `caches.default` and only invoke the binding on a miss. A Cache API key is
 * a `Request`, matched by its URL — so every field that changes the transformed
 * bytes MUST be in the URL:
 *
 *  - `slug` + `slot` — which asset.
 *  - `variant` — the resolved render width (bounded to the 3-variant allowlist).
 *  - `format` — the Accept-negotiated output format. Critical: the chosen format
 *    is NOT in the request URL (it comes from the `Accept` header), so baking it
 *    into the key is what keeps AVIF/WebP/JPEG as separate entries — otherwise a
 *    WebP-only client could be served an AVIF cached for an AVIF-capable one.
 *  - `v` — the content version, derived SERVER-SIDE from the slot's own R2 key
 *    (`versionFromKey`, NOT the client `?v=`, which is ignored for keying — S-M1),
 *    so a re-upload mints a fresh key → a new `v` → the new image isn't served
 *    stale, while an attacker can't loop arbitrary `?v=` values to mint fresh
 *    transforms, and bumping one slot never busts another slot's cached entry.
 *  - `blur` — the server-derived hero backdrop blur radius (per-wedding
 *    `hero_blur`, migration 0018), present only for the `hero-bg` variant. A
 *    blur-only save touches no image key, so the hero slot's version folds the
 *    radius into its digest as well (`heroVersionFromKey`, `invite.ts`) — `v`
 *    busts the cache on its own. We ALSO fold `blur` in here defensively so the
 *    cached bytes can never disagree with the requested radius. It stays
 *    bounded: exactly one server-derived value per wedding, not a client-swept
 *    param.
 *
 * The format slug strips the `image/` prefix to keep the key tidy. We use a
 * synthetic host so the key never collides with a real inbound request URL and
 * is independent of the request's own host/scheme.
 */
export function buildTransformCacheKey(args: {
  slug: string;
  slot: string;
  variant: ImageVariant;
  format: OutputFormat;
  version?: string | null;
  blur?: number | null;
}): Request {
  const formatSlug = args.format.replace("image/", "");
  const params = new URLSearchParams({
    variant: args.variant,
    format: formatSlug,
  });
  if (args.version) params.set("v", args.version);
  if (args.blur !== undefined && args.blur !== null) params.set("blur", String(args.blur));
  const url = `https://cire-image-cache.internal/${encodeURIComponent(args.slug)}/${encodeURIComponent(
    args.slot,
  )}?${params.toString()}`;
  return new Request(url, { method: "GET" });
}

// ── Binding wrapper ───────────────────────────────────────────────────────────

/**
 * Minimal structural shape of the Workers Images binding we depend on — narrow
 * by design (mirrors the `AssetsBucket` Tag style) so a test stub implements
 * just `input().transform().output()`. The real `ImagesBinding` from
 * `@cloudflare/workers-types` satisfies this structurally.
 */
export interface ImageTransformer {
  width?: number;
}

export interface ImageOutput {
  /** The transformed image as a Response (carries the right content-type). */
  response(): Response;
  contentType(): string;
}

/** Options one `transform()` step accepts — both are omitted when not applicable. */
export interface ImageTransformOptions {
  width?: number;
  blur?: number;
}

export interface ImageTransformHandle {
  transform(t: ImageTransformOptions): ImageTransformHandle;
  output(o: { format: OutputFormat; quality?: number }): Promise<ImageOutput>;
}

export interface ImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): ImageTransformHandle;
}

export class ImageTransformError extends Data.TaggedError("ImageTransformError")<{
  readonly reason: string;
  readonly variant: ImageVariant;
  readonly format: OutputFormat;
  readonly cause?: unknown;
}> {}

/** JPEG quality for the lossy outputs — a sane visual/size tradeoff for photos. */
const OUTPUT_QUALITY = 82;

/**
 * Run the original bytes through the Images binding for the given variant +
 * negotiated format, returning the transformed bytes + their content-type.
 * Fails with {@link ImageTransformError} when the binding throws — the caller
 * catches and falls back to the original. A successful transform's content-type
 * comes from the binding (it knows what it actually produced).
 *
 * A variant with a {@link VARIANT_BLUR} entry (today only `hero-bg`) also gets a
 * server-side Gaussian blur — the soft hero backdrop. The radius is server-
 * derived, never request input: the optional `blurOverride` (the per-wedding
 * `hero_blur`, migration 0018) takes precedence over the {@link VARIANT_BLUR}
 * default when given. A `0` override is honoured (sharp backdrop) — only
 * `undefined` falls back to the variant default. Sharp variants stay un-blurred.
 */
export function transformAsset(
  images: ImagesBindingLike,
  original: StoredAsset,
  variant: ImageVariant,
  format: OutputFormat,
  blurOverride?: number,
): Effect.Effect<StoredAsset, ImageTransformError> {
  return Effect.tryPromise({
    try: async () => {
      const stream = new Response(original.bytes).body;
      if (!stream) {
        throw new Error("original asset had no readable body");
      }
      // Only the blurred backdrop variant takes a blur at all. Within it, the
      // per-wedding override wins (including an explicit 0 ⇒ sharp); absent an
      // override we fall back to the server-constant default.
      const variantDefault = blurForVariant(variant);
      const blur =
        variantDefault === undefined
          ? undefined
          : blurOverride !== undefined
            ? blurOverride
            : variantDefault;
      const options: ImageTransformOptions = { width: IMAGE_VARIANTS[variant] };
      if (blur) options.blur = blur;
      const out = await images
        .input(stream)
        .transform(options)
        .output({ format, quality: OUTPUT_QUALITY });
      const bytes = await out.response().arrayBuffer();
      return { bytes, contentType: out.contentType() };
    },
    catch: (cause) =>
      new ImageTransformError({ reason: "transform failed", variant, format, cause }),
  }).pipe(Effect.withSpan("cire.invite_assets.transform", { attributes: { variant, format } }));
}

// ── Serve pipeline ───────────────────────────────────────────────────────────

/**
 * How long a browser or a shared proxy may reuse a served image without asking
 * the Worker again. Once a copy is outside the Worker no gate sees it, so this
 * is also how long withdrawing an image takes to reach every copy.
 *
 * - `immutable` — a year, never revalidated. The default. A slot's URL changes
 *   with its bytes (a re-upload mints a fresh key and so a fresh `?v=`), so a
 *   long life never serves stale bytes; what it gives up is withdrawal.
 * - `revocable` — {@link REVOCABLE_MAX_AGE_S}, and revalidated after it. For a
 *   `public` slot whose route has a gate that can close — the guest gift list
 *   can be unpublished — so that closing it reaches browser and proxy copies in
 *   bounded time rather than in a year.
 */
export type ImageClientLifetime = "immutable" | "revocable";

/** A year: the lifetime of every image whose URL changes with its bytes. */
const IMMUTABLE_MAX_AGE_S = 31_536_000;

/**
 * One hour: the longest a `revocable` image outlives the gate that served it.
 * Long enough that a guest's visit to the gift page is served from the browser
 * cache; past it, each image costs one gated request again.
 */
export const REVOCABLE_MAX_AGE_S = 3_600;

/** The `Cache-Control` a client receives for a slot's visibility and lifetime. */
export function imageCacheControl(
  visibility: "public" | "private",
  lifetime: ImageClientLifetime,
): string {
  return lifetime === "revocable"
    ? `${visibility}, max-age=${REVOCABLE_MAX_AGE_S}`
    : `${visibility}, max-age=${IMMUTABLE_MAX_AGE_S}, immutable`;
}

/**
 * Response headers for both the transformed and the streamed-original serve
 * paths. The cache-hit path re-stamps `Cache-Control` through the same
 * {@link imageCacheControl}, so the two paths cannot disagree.
 *
 * `Vary: Accept, Origin`: the app-level CORS plugin echoes a per-request
 * `Access-Control-Allow-Origin`, so a cached `no-cors` entry served back to a
 * `cors`-mode consumer fails the CORS check without a network hit. `Origin` in
 * Vary makes the browser cache CORS-mode and no-cors-mode responses
 * separately — the mode-mixing that broke the crop editor.
 */
export function imageResponseHeaders(
  contentType: string,
  visibility: "public" | "private" = "public",
  lifetime: ImageClientLifetime = "immutable",
) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    // `private` for session-gated slots (the closing section's motif) and for
    // every organiser-only image: the bytes are only for the household that
    // claimed a code, or for the couple's own portal, so no shared cache — CDN,
    // proxy or otherwise — may keep a copy it could hand to another visitor. The
    // per-colo Workers Cache API is still used for them (see
    // `serveTransformedImage`); that lookup happens AFTER the auth check, so an
    // unauthenticated request never reaches it.
    "Cache-Control": imageCacheControl(visibility, lifetime),
    Vary: "Accept, Origin",
  };
}

/**
 * The `Cache-Control` the STORED copy carries.
 *
 * Cloudflare's Cache API documents a `private` response as unstorable — `cache.put`
 * rejects with a 413 rather than storing it — so a gated slot that stored its
 * client copy would pay the Images binding on every request while believing it had
 * a hit. The copy handed to `put` therefore says `public` and a year; the copy
 * handed to the CLIENT says whatever {@link imageCacheControl} decides for the
 * slot, on the miss and the hit path alike.
 *
 * That is safe because the cache key is synthetic — `buildTransformCacheKey` mints
 * a URL from the slot, variant, format and SERVER-derived version, and no inbound
 * request URL can name it — and because the lookup happens after auth, the role
 * gate and the entitlement check. `public` here means "this per-colo store may hold
 * it", not "any proxy may"; nothing between us and the browser ever sees this
 * header.
 *
 * VERIFIED against the deployed dev Worker on 2026-08-19: a repeat request showed
 * a Cache API HIT with `age` advancing, `cache-control: private, max-age=31536000,
 * immutable` on the way out to the client, and zero `image cache put failed`
 * events in the tail.
 */
const STORABLE_CACHE_CONTROL = imageCacheControl("public", "immutable");

/** Copy a response, swapping in one header. Bodies are teed by the caller. */
function withCacheControl(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", value);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The client's copy of a Cache API hit: the slot's own `Cache-Control`, stamped
 * as fresh.
 *
 * A hit comes back carrying the `Age` it has built up in the store, and may carry
 * the `Date` it was stored under. Passed on, either one makes a `revocable` image
 * stale on arrival once its stored copy is older than
 * {@link REVOCABLE_MAX_AGE_S}, and the browser would fetch it again on every page
 * load. The Worker is this response's origin and ran the route's gate for it just
 * now, so it answers with no `Age` and a `Date` of now.
 */
function freshForClient(hit: Response, cacheControl: string): Response {
  const response = withCacheControl(hit, cacheControl);
  response.headers.delete("Age");
  response.headers.set("Date", new Date().toUTCString());
  return response;
}

/**
 * Serve a transformed image given an already-resolved R2 key + server-derived
 * content version. Shared by the wedding-slot (`hero`/`story`), the per-event and
 * the registry-item serve routes so all three get the IDENTICAL Cache-API-short-
 * circuit + Images-binding transform + raw-original fallback pipeline.
 *
 * `cacheSlot` is the slot segment of the Cache API key (e.g. `"hero"`,
 * `"event:<eventId>"`, `"registry:<weddingId>"`) — every field that changes the
 * transformed bytes is folded into the key, and the version is ALWAYS the
 * server-derived one (NEVER the client `?v=`), so no caller can mint arbitrary
 * cache entries. `blurOverride` is only ever passed for the blurred `hero-bg`
 * variant; event and registry images render sharp (undefined).
 *
 * `visibility` and `lifetime` shape only the client's `Cache-Control`, never the
 * cache key or the stored copy — see {@link imageCacheControl} and
 * {@link STORABLE_CACHE_CONTROL}.
 *
 * Returns a `Response`. Requires `AssetsR2Service` for the R2 read. Fails with
 * `AssetR2Error` when the key is missing from R2 (caller maps to 404).
 */
export function serveTransformedImage(args: {
  request: Request;
  key: string;
  version: string | undefined;
  cacheSlot: string;
  variant: ImageVariant;
  format: OutputFormat;
  blurOverride?: number;
  images?: ImagesBindingLike;
  /** `private` for session- or organiser-gated slots — no shared cache copy. */
  visibility?: "public" | "private";
  /** `revocable` for a public slot whose gate can close — see {@link ImageClientLifetime}. */
  lifetime?: ImageClientLifetime;
}): Effect.Effect<Response, AssetR2Error, AssetsR2Service> {
  const {
    request,
    key,
    version,
    cacheSlot,
    variant,
    format,
    blurOverride,
    images,
    visibility = "public",
    lifetime = "immutable",
  } = args;
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
        // The stored copy says `public` and a year so the store would accept it;
        // re-stamp the slot's own visibility and lifetime on the way out, or a
        // private image would tell the browser it was shareable, and a revocable
        // one that it could keep for a year, purely because it had been cached once.
        return freshForClient(hit, imageCacheControl(visibility, lifetime));
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
      response = new Response(served.bytes, {
        headers: imageResponseHeaders(served.contentType, visibility, lifetime),
      });
    } else {
      // Original-serve path (no Images binding — local/dev/tests, or an account
      // without the Images product): STREAM R2's body straight into the Response
      // instead of buffering the whole (≤5 MB) image in Worker memory (IB-P-I2).
      // `response.clone()` below tees the stream, so the Cache API `put` and the
      // returned body each get an independent copy.
      const streamed = yield* fetchAssetStream(key);
      metricImageTransform("original", variant, format);
      response = new Response(streamed.body, {
        headers: imageResponseHeaders(streamed.contentType, visibility, lifetime),
      });
    }

    if (cache && cacheKey) {
      // Store a copy the cache will actually accept (P-W2) — see
      // {@link STORABLE_CACHE_CONTROL}. `response.clone()` tees the body first, so
      // the returned response keeps its own readable copy.
      const storable = withCacheControl(response.clone(), STORABLE_CACHE_CONTROL);
      const put = Effect.tryPromise({
        try: () => cache.put(cacheKey, storable),
        catch: (cause) => cause,
      }).pipe(
        // A refused put is a missed cache, not a failed request — but silence here
        // is what let the refusal go unnoticed in the first place, and off the
        // request's own promise chain it would surface as an unhandled rejection.
        Effect.catch((cause) =>
          Effect.logWarning("image cache put failed", {
            cacheSlot,
            variant,
            format,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      );
      const waitUntil = getWaitUntil(request);
      if (waitUntil) {
        waitUntil(Effect.runPromise(put));
      } else {
        yield* put;
      }
    }

    return response;
  });
}
