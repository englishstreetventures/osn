import { Data, Effect } from "effect";

import type { StoredAsset } from "./invite-assets";

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
 * Server-chosen Gaussian blur radius (in Cloudflare Images terms, roughly 0–250)
 * applied per variant. Only `hero-bg` is blurred — a tasteful "soft backdrop"
 * radius: enough to abstract the photo behind the title without dissolving it.
 * Tune here (one constant, server-side only — never from request input). Variants
 * absent from this map are served sharp. Start ~28; bump toward 35–40 for softer.
 */
export const VARIANT_BLUR: Partial<Record<ImageVariant, number>> = {
  "hero-bg": 28,
} as const;

/** The blur radius for a variant, or `undefined` when it should render sharp. */
export function blurForVariant(variant: ImageVariant): number | undefined {
  return VARIANT_BLUR[variant];
}

/** Ordered widest→narrowest, for emitting a `srcset` on the frontend. */
export const VARIANT_NAMES = ["thumb", "card", "hero"] as const;

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
 *  - `v` — the content version, derived SERVER-SIDE from the wedding row's
 *    `updatedAt` (NOT the client `?v=`, which is ignored for keying — S-M1), so a
 *    re-upload bumps `updatedAt` → a new key → the new image isn't served stale,
 *    while an attacker can't loop arbitrary `?v=` values to mint fresh transforms.
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
}): Request {
  const formatSlug = args.format.replace("image/", "");
  const params = new URLSearchParams({
    variant: args.variant,
    format: formatSlug,
  });
  if (args.version) params.set("v", args.version);
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

export interface ImageTransformHandle {
  transform(t: { width?: number; blur?: number }): ImageTransformHandle;
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
 * server-side Gaussian blur — the soft hero backdrop. The blur radius is a server
 * constant keyed by the bounded variant name, never request input.
 */
export function transformAsset(
  images: ImagesBindingLike,
  original: StoredAsset,
  variant: ImageVariant,
  format: OutputFormat,
): Effect.Effect<StoredAsset, ImageTransformError> {
  return Effect.tryPromise({
    try: async () => {
      const stream = new Response(original.bytes).body;
      if (!stream) {
        throw new Error("original asset had no readable body");
      }
      const blur = blurForVariant(variant);
      const out = await images
        .input(stream)
        .transform({ width: IMAGE_VARIANTS[variant], ...(blur ? { blur } : {}) })
        .output({ format, quality: OUTPUT_QUALITY });
      const bytes = await out.response().arrayBuffer();
      return { bytes, contentType: out.contentType() };
    },
    catch: (cause) =>
      new ImageTransformError({ reason: "transform failed", variant, format, cause }),
  }).pipe(Effect.withSpan("cire.invite_assets.transform", { attributes: { variant, format } }));
}
