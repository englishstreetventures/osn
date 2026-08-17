import { Data, Effect } from "effect";

import { metricRegistryImageSave } from "../metrics";
import type { RegistryImageSaveResult, RegistryImageSource } from "../metrics";
import { versionFromKey } from "./event-image";
import { detectImageType, MAX_IMAGE_BYTES, storeAsset } from "./invite-assets";
import type { AllowedImageType, AssetR2Error, AssetsR2Service } from "./invite-assets";
import {
  createDohResolver,
  createUrlGuard,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  readCappedBytes,
} from "./link-preview";
import type { BlockReason, GuardedFetchFailure, LinkPreviewOptions } from "./link-preview";

/**
 * Registry item images — the bytes behind `registry_items.image_key`.
 *
 * A registry item's picture arrives one of two ways: the organiser uploads a
 * file, or they paste a shop link, we show them what that page offers
 * (`link-preview.ts`) and they pick one. Both paths end HERE, and both end with
 * bytes in the `cire-assets` R2 bucket under the same `assets/<weddingId>/…`
 * namespace the invite builder uses.
 *
 * The picked-URL path deliberately does NOT store the URL. Storing it and
 * rendering it later would be hotlinking, which fails three ways: the link rots
 * and the item loses its picture months after the couple stopped looking; every
 * guest who opens the registry sends a referrer to a shop we don't control; and
 * the shop can swap the bytes after the organiser approved them, so what the
 * couple saw and what the guests see are only related by the shop's goodwill.
 * Copying at pick time makes the picture ours: a key, an immutable object, and
 * the same serve path every other invite image goes down.
 *
 * The URL is re-guarded here even though we emitted it. It comes back in a
 * request body, and a request body is client-controlled — nothing in it proves
 * it came from a preview we ran. So {@link storeFromUrl} runs the identical
 * guard {@link guardedFetch} enforces for the preview: https only, no
 * credentials, DoH pre-resolution with every private/loopback/link-local/CGNAT/
 * ULA/NAT64 range refused, manual redirects re-checked per hop, one time budget
 * across all of it, and a hard byte cap on the body.
 *
 * The declared `Content-Type` is never trusted for the accept/reject decision:
 * the type comes from {@link detectImageType} sniffing magic bytes, whose return
 * type IS the allowlist (`ALLOWED_IMAGE_TYPES`), so an HTML error page served as
 * `image/png` is refused on its signature.
 */

export class RegistryImageBlocked extends Data.TaggedError("RegistryImageBlocked")<{
  readonly reason: BlockReason;
}> {}

export class RegistryImageFetchFailed extends Data.TaggedError("RegistryImageFetchFailed")<{
  readonly reason: "network" | "timeout" | "status" | "too_many_redirects";
}> {}

/** The bytes are not one of the allowlisted raster formats (magic-byte verdict). */
export class RegistryImageUnsupportedType extends Data.TaggedError("RegistryImageUnsupportedType")<{
  /** The DECLARED type, for the log line only — never the reason for the refusal. */
  readonly declared?: string;
}> {}

export class RegistryImageTooLarge extends Data.TaggedError("RegistryImageTooLarge")<{
  readonly limit: number;
}> {}

export type RegistryImageError =
  | RegistryImageBlocked
  | RegistryImageFetchFailed
  | RegistryImageUnsupportedType
  | RegistryImageTooLarge;

export interface SavedRegistryImage {
  /** R2 key — what the caller puts in `registry_items.image_key`. */
  readonly imageKey: string;
  /** Path the organiser portal renders (needs the caller's auth — see the route). */
  readonly imageUrl: string;
  readonly contentType: AllowedImageType;
  readonly byteLength: number;
}

/**
 * Path a registry image is served from. Only the key's LAST segment travels in
 * the URL — the route rebuilds `assets/<weddingId>/<name>` from its own
 * `:weddingId` param, so no client-supplied key can ever address another
 * wedding's object. `?v=` is the server-derived content version (a fresh uuid in
 * every key ⇒ a fresh version per save); it is a cache buster the server mints,
 * never one a client can choose.
 */
export function registryImagePath(weddingId: string, imageKey: string, version: string): string {
  const name = imageKey.slice(imageKey.lastIndexOf("/") + 1);
  return `/api/organiser/weddings/${encodeURIComponent(weddingId)}/registry/image/${encodeURIComponent(name)}?v=${version}`;
}

/** Map a guarded-fetch failure onto this module's tagged errors. */
function toImageError(
  failure: GuardedFetchFailure,
): RegistryImageBlocked | RegistryImageFetchFailed {
  return failure.kind === "blocked"
    ? new RegistryImageBlocked({ reason: failure.reason })
    : new RegistryImageFetchFailed({ reason: failure.reason });
}

/** Which bounded metric outcome an error counts as. */
function resultOf(error: RegistryImageError | AssetR2Error): RegistryImageSaveResult {
  switch (error._tag) {
    case "RegistryImageBlocked":
      return "blocked";
    case "RegistryImageFetchFailed":
      return "fetch_failed";
    case "RegistryImageUnsupportedType":
      return "unsupported_type";
    case "RegistryImageTooLarge":
      return "too_large";
    default:
      return "error";
  }
}

/**
 * One log line per failure, with BOUNDED annotations only — a reason string from
 * a closed union, a byte count, a truncated declared content type. Never the
 * URL: a registry link names something the couple is buying, and the resolved
 * address is never logged beside it either. A refused private address is an
 * ERROR (someone pointed us inward); the rest are the internet being itself.
 */
function logFailure(
  source: RegistryImageSource,
  error: RegistryImageError | AssetR2Error,
): Effect.Effect<void> {
  switch (error._tag) {
    case "RegistryImageBlocked":
      return error.reason === "private_address"
        ? Effect.logError("registry image refused a non-public destination").pipe(
            Effect.annotateLogs({ source, reason: error.reason }),
          )
        : Effect.logWarning("registry image refused a url").pipe(
            Effect.annotateLogs({ source, reason: error.reason }),
          );
    case "RegistryImageFetchFailed":
      return Effect.logWarning("registry image fetch failed").pipe(
        Effect.annotateLogs({ source, reason: error.reason }),
      );
    case "RegistryImageUnsupportedType":
      return Effect.logWarning("registry image rejected — bytes are not an allowed image").pipe(
        Effect.annotateLogs({ source, declared: (error.declared ?? "none").slice(0, 64) }),
      );
    case "RegistryImageTooLarge":
      return Effect.logWarning("registry image rejected — over the byte cap").pipe(
        Effect.annotateLogs({ source, limit: error.limit }),
      );
    default:
      return Effect.logError("registry image store failed").pipe(
        Effect.annotateLogs({ source, reason: error.reason }),
      );
  }
}

/**
 * Sniff + store. The single place both paths converge on, so the magic-byte
 * verdict is impossible to skip on one of them.
 */
function sniffAndStore(
  weddingId: string,
  bytes: ArrayBuffer,
  declared: string | undefined,
  source: RegistryImageSource,
): Effect.Effect<SavedRegistryImage, RegistryImageError | AssetR2Error, AssetsR2Service> {
  return Effect.gen(function* () {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return yield* Effect.fail(new RegistryImageTooLarge({ limit: MAX_IMAGE_BYTES }));
    }
    // The verdict is the SIGNATURE, not the header. `detectImageType` returns
    // `AllowedImageType | null`, so its return type is the allowlist itself —
    // there is no second check to forget to keep in step with it.
    const contentType = detectImageType(bytes);
    if (contentType === null) {
      return yield* Effect.fail(new RegistryImageUnsupportedType({ declared }));
    }
    const imageKey = yield* storeAsset(weddingId, "registry", bytes, contentType);
    yield* Effect.logInfo("registry image saved", { weddingId, source });
    yield* Effect.sync(() => metricRegistryImageSave(source, "ok"));
    return {
      imageKey,
      imageUrl: registryImagePath(weddingId, imageKey, versionFromKey(imageKey)),
      contentType,
      byteLength: bytes.byteLength,
    } satisfies SavedRegistryImage;
  });
}

export const registryImageService = {
  /**
   * Store an image the organiser uploaded from their own machine. The route has
   * already refused an over-cap `Content-Length`; this re-checks the REAL length
   * because that header is a claim by the same client sending the body.
   */
  storeUpload(
    weddingId: string,
    bytes: ArrayBuffer,
    declaredContentType?: string,
  ): Effect.Effect<SavedRegistryImage, RegistryImageError | AssetR2Error, AssetsR2Service> {
    return sniffAndStore(weddingId, bytes, declaredContentType, "upload").pipe(
      Effect.tapError((error) =>
        logFailure("upload", error).pipe(
          Effect.andThen(Effect.sync(() => metricRegistryImageSave("upload", resultOf(error)))),
        ),
      ),
      Effect.withSpan("cire.registry.image.storeUpload"),
    );
  },

  /**
   * Copy the bytes behind one candidate URL into R2. The URL is treated as fully
   * untrusted — see the module docstring — so it re-runs the same guard the
   * preview fetch uses, under the same caps.
   *
   * `options` is the SAME shape the preview route injects, so a test drives both
   * halves of the flow through one fetch/DNS seam. `maxBytes` defaults to the
   * image cap rather than the preview's HTML cap.
   */
  storeFromUrl(
    weddingId: string,
    rawUrl: string,
    options: LinkPreviewOptions = {},
  ): Effect.Effect<SavedRegistryImage, RegistryImageError | AssetR2Error, AssetsR2Service> {
    const {
      maxRedirects = DEFAULT_MAX_REDIRECTS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBytes = MAX_IMAGE_BYTES,
      fetchImpl = fetch,
      resolveHost = createDohResolver(fetchImpl),
    } = options;

    return Effect.gen(function* () {
      // ONE budget for the whole operation — every hop and the body read share
      // it, so three hosts each answering just inside a per-hop timeout can't
      // add up to a Worker's whole wall clock.
      const signal = AbortSignal.timeout(timeoutMs);
      // The guard carries the same signal, so its DNS lookups run inside that
      // budget rather than beside it (P-W3).
      const guard = createUrlGuard(resolveHost, signal);

      const fetched = yield* Effect.promise(() =>
        guardedFetch({
          url: rawUrl,
          guard,
          fetchImpl,
          maxRedirects,
          signal,
          accept: "image/*",
          userAgent: "cire-registry-image/1.0",
        }),
      );
      if (!fetched.ok) return yield* Effect.fail(toImageError(fetched.failure));

      const declared = fetched.response.headers.get("content-type") ?? undefined;
      const read = yield* Effect.promise(() =>
        readCappedBytes(fetched.response, maxBytes).then(
          (r) => ({ ok: true as const, r }),
          // A read that rejects mid-stream is the remote hanging up (or our own
          // budget expiring), not a size verdict.
          () => ({ ok: false as const, r: undefined }),
        ),
      );
      if (!read.ok) {
        return yield* Effect.fail(
          new RegistryImageFetchFailed({ reason: signal.aborted ? "timeout" : "network" }),
        );
      }
      if (!read.r.ok) {
        return yield* Effect.fail(new RegistryImageTooLarge({ limit: maxBytes }));
      }

      // A `Uint8Array` over an exactly-sized buffer — `buffer` is the whole image.
      const bytes = read.r.bytes.buffer as ArrayBuffer;
      return yield* sniffAndStore(weddingId, bytes, declared, "url");
    }).pipe(
      Effect.tapError((error) =>
        logFailure("url", error).pipe(
          Effect.andThen(Effect.sync(() => metricRegistryImageSave("url", resultOf(error)))),
        ),
      ),
      Effect.withSpan("cire.registry.image.storeFromUrl"),
    );
  },
};
