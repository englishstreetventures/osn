import { Context, Data, Effect } from "effect";

import type { InviteImageSlot } from "../schemas/invite";

/**
 * The label that namespaces an R2 image key. The two wedding-level invite slots
 * (`hero`/`story`) plus `event` (one optional image per event, keyed by event id
 * in `events.event_image_key`). It only affects the readable key prefix — the
 * uuid suffix is what guarantees per-upload uniqueness — so a closed union is
 * enough; it never has to mirror an `:slot` route param like `InviteImageSlot`.
 */
export type AssetSlotLabel = InviteImageSlot | "event";

// Binary R2 surface for invite images. The CSV-import `R2Bucket` in
// `r2-imports.ts` is text-only (`get().text()`), so images get their own narrow
// Tag rather than widening that interface in place: uploads need `arrayBuffer()`
// on read and a content-type round-trip via `httpMetadata`. The Cloudflare
// Workers `R2Bucket` type satisfies this structurally; the in-memory test stub
// implements just these methods.
export interface AssetObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly httpMetadata?: { contentType?: string };
}

export interface AssetsBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> | unknown;
  get(key: string): Promise<AssetObjectBody | null> | AssetObjectBody | null;
  delete(key: string): Promise<unknown> | unknown;
}

export class AssetsR2Service extends Context.Tag("AssetsR2Service")<
  AssetsR2Service,
  AssetsBucket
>() {}

export class AssetR2Error extends Data.TaggedError("AssetR2Error")<{
  readonly reason: string;
  readonly key?: string;
  readonly cause?: unknown;
}> {}

/** R2 key namespace for invite images: `assets/<weddingId>/<slot>-<uuid>`. */
function assetKey(weddingId: string, slot: AssetSlotLabel): string {
  return `assets/${weddingId}/${slot}-${crypto.randomUUID()}`;
}

export interface StoredAsset {
  bytes: ArrayBuffer;
  contentType: string;
}

/**
 * Store an image for a wedding's slot and return its freshly-minted R2 key.
 * Keys carry a uuid suffix so a re-upload to the same slot never collides and
 * the previous object can be deleted independently (see `invite.ts`).
 */
export function storeAsset(
  weddingId: string,
  slot: AssetSlotLabel,
  bytes: ArrayBuffer,
  contentType: string,
): Effect.Effect<string, AssetR2Error, AssetsR2Service> {
  return Effect.gen(function* () {
    const bucket = yield* AssetsR2Service;
    const key = assetKey(weddingId, slot);
    yield* Effect.tryPromise({
      try: async () => {
        await Promise.resolve(bucket.put(key, bytes, { httpMetadata: { contentType } }));
      },
      catch: (cause) => new AssetR2Error({ reason: "store failed", key, cause }),
    });
    return key;
  }).pipe(Effect.withSpan("cire.invite.storeAsset"));
}

/** Fetch image bytes + content type for serving. Fails when the key is absent. */
export function fetchAsset(key: string): Effect.Effect<StoredAsset, AssetR2Error, AssetsR2Service> {
  return Effect.gen(function* () {
    const bucket = yield* AssetsR2Service;
    const result = yield* Effect.tryPromise({
      try: async () => {
        const obj = await Promise.resolve(bucket.get(key));
        if (!obj) return null;
        const bytes = await obj.arrayBuffer();
        return { bytes, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
      },
      catch: (cause) => new AssetR2Error({ reason: "fetch failed", key, cause }),
    });
    if (result === null) {
      return yield* Effect.fail(new AssetR2Error({ reason: "key not found", key }));
    }
    return result;
  }).pipe(Effect.withSpan("cire.invite.fetchAsset"));
}

/**
 * Best-effort delete of a superseded/removed image. A failure here only orphans
 * an R2 object (cleaned up out of band); it must not fail the caller's request,
 * so callers log-and-continue rather than surfacing this.
 */
export function deleteAsset(key: string): Effect.Effect<void, AssetR2Error, AssetsR2Service> {
  return Effect.gen(function* () {
    const bucket = yield* AssetsR2Service;
    yield* Effect.tryPromise({
      try: async () => {
        await Promise.resolve(bucket.delete(key));
      },
      catch: (cause) => new AssetR2Error({ reason: "delete failed", key, cause }),
    });
  }).pipe(Effect.withSpan("cire.invite.deleteAsset"));
}

// ── Image type detection ──────────────────────────────────────────────────────

/** Allowlisted image content types — also the only types the builder serves. */
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Max upload size for an invite image (5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Sniff the real image type from magic bytes rather than trusting the declared
 * Content-Type — a mislabelled or hostile upload (e.g. an HTML/SVG payload sent
 * as `image/png`) is rejected because its signature won't match. Returns null
 * when the bytes aren't one of the allowlisted raster formats.
 */
export function detectImageType(bytes: ArrayBuffer): AllowedImageType | null {
  const b = new Uint8Array(bytes);
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// ── Test stub ─────────────────────────────────────────────────────────────────

/** In-memory AssetsBucket for unit tests — mirrors the methods used above. */
export function createAssetsStub(): AssetsBucket & {
  _store: Map<string, { bytes: ArrayBuffer; contentType?: string }>;
} {
  const store = new Map<string, { bytes: ArrayBuffer; contentType?: string }>();
  return {
    _store: store,
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const bytes =
        value instanceof ArrayBuffer
          ? value.slice(0)
          : (value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            ) as ArrayBuffer);
      store.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      return Promise.resolve();
    },
    get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      return {
        arrayBuffer: () => Promise.resolve(v.bytes),
        httpMetadata: { contentType: v.contentType },
      };
    },
    delete(key: string) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}
