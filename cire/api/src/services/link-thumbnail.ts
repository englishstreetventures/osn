import { Data, Effect } from "effect";

import { getWaitUntil } from "../lib/execution-ctx";
import { metricRegistryLinkThumb } from "../metrics";
import type { RegistryLinkThumbResult } from "../metrics";
import { detectImageType, MAX_IMAGE_BYTES } from "./invite-assets";
import { buildTransformCacheKey, transformAsset } from "./invite-image-transform";
import type { ImagesBindingLike, OutputFormat } from "./invite-image-transform";
import {
  createDohResolver,
  createUrlGuard,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  readCappedBytes,
} from "./link-preview";
import type { BlockReason, LinkPreviewOptions } from "./link-preview";

/**
 * The link picker's thumbnails — one candidate image from a shop page, fetched
 * by cire-api and re-encoded, so the organiser's browser never loads a shop's
 * host and the portal's CSP `img-src` can stay closed to every https origin.
 *
 * The URL arrives in a request body, so it is fully untrusted, whether or not
 * the preview emitted it a moment ago. It goes through the link-preview guard —
 * `createUrlGuard` + `guardedFetch` + `readCappedBytes`, the same functions the
 * preview and `registry-image.ts` run, not a copy: https only, no credentials,
 * every address behind the host range-checked over DoH, manual redirects
 * re-checked per hop, one 5-second budget across all of it.
 *
 * Then, on the bytes:
 *
 *  - a hard cap of {@link MAX_IMAGE_BYTES}, the same as the image save, so
 *    anything an organiser can pick can be shown. `options.maxBytes` is ignored:
 *    the options object is shared with the preview, whose cap is for HTML.
 *  - `detectImageType` on the leading bytes. The declared type is never the
 *    reason to accept; anything that is not JPEG, PNG or WebP is refused.
 *  - the Images binding at the `thumb` width (320px) in the negotiated format.
 *    A failed transform is an error, never a fallback to the shop's bytes.
 *
 * Without the binding the sniffed bytes are served as they arrived — the local
 * path, where `bun run dev` has no Images binding. A deployed tier sets
 * `requireTransform`, and there a missing binding refuses before any fetch, so
 * a deploy that loses `[images]` cannot turn this into a raw image proxy.
 *
 * Every binding call is treated as billed, and the account's Images quota is
 * shared with the invite images guests load, so a transformed thumbnail is
 * stored in the Workers Cache API under a synthetic key — the wedding, the
 * SHA-256 of the URL and the output format — and a repeat is served from there
 * with no fetch and no transform. The key is looked up only after the route's
 * gates, and the wedding in it keeps one couple's previews out of another's.
 *
 * Logs carry bounded reasons only, never the URL: a registry link names
 * something the couple is buying.
 */

export class LinkThumbBlocked extends Data.TaggedError("LinkThumbBlocked")<{
  readonly reason: BlockReason;
}> {}

export class LinkThumbFetchFailed extends Data.TaggedError("LinkThumbFetchFailed")<{
  readonly reason: "network" | "timeout" | "status" | "too_many_redirects";
}> {}

/** The bytes are not JPEG, PNG or WebP (magic-byte verdict). */
export class LinkThumbUnsupportedType extends Data.TaggedError("LinkThumbUnsupportedType")<{
  /** The DECLARED type, for the log line only. */
  readonly declared?: string;
}> {}

export class LinkThumbTooLarge extends Data.TaggedError("LinkThumbTooLarge")<{
  readonly limit: number;
}> {}

/** The Images binding refused or failed — a spent quota included. */
export class LinkThumbTransformFailed extends Data.TaggedError("LinkThumbTransformFailed") {}

/** A deployed tier with no Images binding: we will not serve unencoded bytes. */
export class LinkThumbUnavailable extends Data.TaggedError("LinkThumbUnavailable") {}

export type LinkThumbError =
  | LinkThumbBlocked
  | LinkThumbFetchFailed
  | LinkThumbUnsupportedType
  | LinkThumbTooLarge
  | LinkThumbTransformFailed
  | LinkThumbUnavailable;

/**
 * Headers on every thumbnail. The bytes came from a host the caller chose, so
 * the response says what it is and nothing else may be made of it: `nosniff`
 * pins the type, and the sandboxing CSP stops it running as a document if it is
 * ever opened as one. `private, no-store`: these are one organiser's picks.
 */
function thumbHeaders(contentType: string) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    Vary: "Accept, Origin",
  };
}

/** What the stored copy says, so the Cache API accepts it. Never sent to a client. */
const STORED_CACHE_CONTROL = "public, max-age=86400";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function resultOf(error: LinkThumbError): RegistryLinkThumbResult {
  switch (error._tag) {
    case "LinkThumbBlocked":
      return "blocked";
    case "LinkThumbFetchFailed":
      return "fetch_failed";
    case "LinkThumbUnsupportedType":
      return "unsupported_type";
    case "LinkThumbTooLarge":
      return "too_large";
    case "LinkThumbTransformFailed":
      return "transform_failed";
    case "LinkThumbUnavailable":
      return "unavailable";
  }
}

/** One log line per failure, bounded annotations only, never the URL. */
function logFailure(error: LinkThumbError): Effect.Effect<void> {
  switch (error._tag) {
    case "LinkThumbBlocked":
      return error.reason === "private_address"
        ? Effect.logError("link thumbnail refused a non-public destination").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          )
        : Effect.logWarning("link thumbnail refused a url").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          );
    case "LinkThumbFetchFailed":
      return Effect.logWarning("link thumbnail fetch failed").pipe(
        Effect.annotateLogs({ reason: error.reason }),
      );
    case "LinkThumbUnsupportedType":
      return Effect.logWarning("link thumbnail rejected — bytes are not an allowed image").pipe(
        Effect.annotateLogs({ declared: (error.declared ?? "none").slice(0, 64) }),
      );
    case "LinkThumbTooLarge":
      return Effect.logWarning("link thumbnail rejected — over the byte cap").pipe(
        Effect.annotateLogs({ limit: error.limit }),
      );
    case "LinkThumbTransformFailed":
      return Effect.logWarning("link thumbnail transform failed");
    case "LinkThumbUnavailable":
      return Effect.logError("link thumbnail refused: no Images binding in a deployed tier");
  }
}

export interface LinkThumbnailArgs {
  /** The inbound request — read for `waitUntil` only. */
  readonly request: Request;
  readonly weddingId: string;
  readonly rawUrl: string;
  readonly format: OutputFormat;
  readonly images?: ImagesBindingLike;
  /** Refuse rather than serve unencoded bytes when `images` is absent. */
  readonly requireTransform: boolean;
  /** Test seam: fetch + DNS. `maxBytes` is ignored — see the module comment. */
  readonly options?: LinkPreviewOptions;
}

/** Fetch, check, re-encode and answer one thumbnail. */
function thumbnail(args: LinkThumbnailArgs): Effect.Effect<Response, LinkThumbError> {
  const { request, weddingId, rawUrl, format, images, requireTransform, options = {} } = args;
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    resolveHost = createDohResolver(fetchImpl),
  } = options;

  return Effect.gen(function* () {
    if (!images && requireTransform) return yield* Effect.fail(new LinkThumbUnavailable());

    // Only transformed bytes are ever stored, so the store is consulted only
    // when the binding is there to produce them.
    const cache =
      images && typeof caches !== "undefined" && caches.default ? caches.default : undefined;
    const cacheKey = cache
      ? buildTransformCacheKey({
          slug: `link-thumb:${weddingId}`,
          slot: yield* Effect.promise(() => sha256Hex(rawUrl)),
          variant: "thumb",
          format,
        })
      : undefined;
    if (cache && cacheKey) {
      const hit = yield* Effect.promise(() => cache.match(cacheKey));
      if (hit) {
        metricRegistryLinkThumb("cache_hit");
        const headers = thumbHeaders(hit.headers.get("Content-Type") ?? format);
        return new Response(hit.body, { status: 200, headers });
      }
    }

    // One budget for every hop, the DNS lookups and the body read.
    const signal = AbortSignal.timeout(timeoutMs);
    const guard = createUrlGuard(resolveHost, signal);
    const fetched = yield* Effect.promise(() =>
      guardedFetch({
        url: rawUrl,
        guard,
        fetchImpl,
        maxRedirects,
        signal,
        accept: "image/*",
        userAgent: "cire-link-thumb/1.0",
      }),
    );
    if (!fetched.ok) {
      const failure = fetched.failure;
      return yield* Effect.fail(
        failure.kind === "blocked"
          ? new LinkThumbBlocked({ reason: failure.reason })
          : new LinkThumbFetchFailed({ reason: failure.reason }),
      );
    }

    const declared = fetched.response.headers.get("content-type") ?? undefined;
    const read = yield* Effect.promise(() =>
      readCappedBytes(fetched.response, MAX_IMAGE_BYTES).then(
        (r) => ({ ok: true as const, r }),
        // A read that rejects mid-stream is the remote hanging up or the
        // budget running out, not a size verdict.
        () => ({ ok: false as const, r: undefined }),
      ),
    );
    if (!read.ok) {
      return yield* Effect.fail(
        new LinkThumbFetchFailed({ reason: signal.aborted ? "timeout" : "network" }),
      );
    }
    if (!read.r.ok) return yield* Effect.fail(new LinkThumbTooLarge({ limit: MAX_IMAGE_BYTES }));

    const bytes = read.r.bytes.buffer as ArrayBuffer;
    const contentType = detectImageType(bytes);
    if (contentType === null) {
      return yield* Effect.fail(new LinkThumbUnsupportedType({ declared }));
    }

    if (!images) {
      metricRegistryLinkThumb("original");
      return new Response(bytes, { status: 200, headers: thumbHeaders(contentType) });
    }

    const out = yield* transformAsset(images, { bytes, contentType }, "thumb", format).pipe(
      Effect.mapError(() => new LinkThumbTransformFailed()),
    );
    metricRegistryLinkThumb("ok");
    const response = new Response(out.bytes, {
      status: 200,
      headers: thumbHeaders(out.contentType),
    });

    if (cache && cacheKey) {
      const stored = new Response(out.bytes.slice(0), {
        headers: { "Content-Type": out.contentType, "Cache-Control": STORED_CACHE_CONTROL },
      });
      const put = Effect.tryPromise({
        try: () => cache.put(cacheKey, stored),
        catch: (cause) => cause,
      }).pipe(
        // A refused put is a missed cache, not a failed request.
        Effect.catch(() => Effect.logWarning("link thumbnail cache put failed")),
      );
      const waitUntil = getWaitUntil(request);
      if (waitUntil) waitUntil(Effect.runPromise(put));
      else yield* put;
    }
    return response;
  }).pipe(
    Effect.tapError((error) =>
      logFailure(error).pipe(
        Effect.andThen(Effect.sync(() => metricRegistryLinkThumb(resultOf(error)))),
      ),
    ),
    Effect.withSpan("cire.registry.link_thumb"),
  );
}

export const linkThumbnailService = { thumbnail };
