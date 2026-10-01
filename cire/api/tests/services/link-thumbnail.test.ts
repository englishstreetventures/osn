import { describe, expect, it } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import { CIRE_METRICS } from "../../src/metrics";
import { MAX_IMAGE_BYTES } from "../../src/services/invite-assets";
import type {
  ImagesBindingLike,
  ImageTransformHandle,
  OutputFormat,
} from "../../src/services/invite-image-transform";
import type { LinkPreviewOptions } from "../../src/services/link-preview";
import { linkThumbnailService } from "../../src/services/link-thumbnail";
import type { LinkThumbnailArgs } from "../../src/services/link-thumbnail";
import { counterValue } from "../test-helpers/metrics-harness";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const HTML = new TextEncoder().encode("<!doctype html><title>not an image</title>");
const TRANSFORMED = new Uint8Array([0xaa, 0xbb, 0xcc]);
const PUBLIC = ["93.184.216.34"];

/** Injected fetch + DNS; records every URL fetched. Nothing here reaches a network. */
function remote(
  handler: (url: string) => Response,
  addresses: (host: string) => readonly string[] = () => PUBLIC,
): LinkPreviewOptions & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    fetchImpl: ((input: string) => {
      fetched.push(String(input));
      return Promise.resolve(handler(String(input)));
    }) as unknown as typeof fetch,
    resolveHost: (host: string) => Promise.resolve(addresses(host)),
  };
}

const png = () =>
  remote(() => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));

/** Images binding stub — records what each transform was asked for. */
function imagesStub(opts: { fail?: boolean } = {}): ImagesBindingLike & {
  calls: { width?: number; format: OutputFormat }[];
} {
  const calls: { width?: number; format: OutputFormat }[] = [];
  return {
    calls,
    input() {
      let width: number | undefined;
      const handle: ImageTransformHandle = {
        transform(t) {
          width = t.width;
          return handle;
        },
        output(o) {
          calls.push({ width, format: o.format });
          if (opts.fail) return Promise.reject(new Error("quota"));
          return Promise.resolve({
            response: () => new Response(TRANSFORMED, { headers: { "Content-Type": o.format } }),
            contentType: () => o.format,
          });
        },
      };
      return handle;
    },
  };
}

function cacheStub() {
  const store = new Map<string, Response>();
  const def = {
    match: (req: Request) => Promise.resolve(store.get(req.url)?.clone()),
    put: (req: Request, res: Response) => {
      store.set(req.url, res);
      return Promise.resolve();
    },
  };
  return { store, caches: { default: def } as unknown as CacheStorage };
}

async function withCaches<T>(stub: CacheStorage, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { caches?: CacheStorage };
  const original = g.caches;
  g.caches = stub;
  try {
    return await fn();
  } finally {
    g.caches = original;
  }
}

function run(over: Partial<LinkThumbnailArgs> & { options: LinkPreviewOptions }) {
  return Effect.runPromiseExit(
    linkThumbnailService.thumbnail({
      request: new Request("https://api.test/thumb", { method: "POST" }),
      weddingId: "wed_1",
      rawUrl: "https://cdn.shop.example/pan.png",
      format: "image/webp",
      requireTransform: false,
      ...over,
    }),
  );
}

function failTag(exit: Exit.Exit<unknown, { _tag: string }>): string | null {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) ? error.value._tag : "defect";
}

describe("linkThumbnailService.thumbnail", () => {
  it("re-encodes through the Images binding at the thumb width, in the asked format", async () => {
    const images = imagesStub();
    const exit = await run({ options: png(), images });
    expect(Exit.isSuccess(exit)).toBe(true);
    const res = (exit as Exit.Success<Response>).value;
    expect(images.calls).toEqual([{ width: 320, format: "image/webp" }]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TRANSFORMED);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("serves the sniffed original when there is no binding and none is required", async () => {
    const before = await counterValue(CIRE_METRICS.registryLinkThumb, { result: "original" });
    const exit = await run({ options: png() });
    const res = (exit as Exit.Success<Response>).value;
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(await counterValue(CIRE_METRICS.registryLinkThumb, { result: "original" })).toBe(
      before + 1,
    );
  });

  it("refuses before any fetch when a deployed tier has lost its binding", async () => {
    const options = png();
    const exit = await run({ options, requireTransform: true });
    expect(failTag(exit)).toBe("LinkThumbUnavailable");
    expect(options.fetched).toEqual([]);
  });

  it("fails rather than fall back to the shop's bytes when the transform fails", async () => {
    const exit = await run({ options: png(), images: imagesStub({ fail: true }) });
    expect(failTag(exit)).toBe("LinkThumbTransformFailed");
  });

  it("refuses a private destination without fetching it", async () => {
    const options = remote(
      () => new Response(PNG),
      () => ["10.0.0.7"],
    );
    const exit = await run({ options, images: imagesStub() });
    expect(failTag(exit)).toBe("LinkThumbBlocked");
    expect(options.fetched).toEqual([]);
  });

  it("re-checks a redirect hop and refuses one that points inward", async () => {
    const options = remote((url) =>
      url.startsWith("https://cdn.shop.example/")
        ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/x" } })
        : new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const exit = await run({ options, images: imagesStub() });
    expect(failTag(exit)).toBe("LinkThumbBlocked");
    expect(options.fetched).toEqual(["https://cdn.shop.example/pan.png"]);
  });

  it("refuses bytes that are not JPEG, PNG or WebP, whatever the header says", async () => {
    for (const body of [GIF, HTML]) {
      const options = remote(
        () => new Response(body, { headers: { "content-type": "image/png" } }),
      );
      const images = imagesStub();
      // oxlint-disable-next-line no-await-in-loop -- two cases, run in turn
      const exit = await run({ options, images });
      expect(failTag(exit)).toBe("LinkThumbUnsupportedType");
      expect(images.calls).toEqual([]);
    }
  });

  it("refuses an image over the cap, on the declared length and on the real one", async () => {
    const declared = remote(
      () =>
        new Response(PNG, {
          headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
        }),
    );
    expect(failTag(await run({ options: declared }))).toBe("LinkThumbTooLarge");

    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG, 0);
    const streamed = remote(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(big);
              c.close();
            },
          }),
        ),
    );
    expect(failTag(await run({ options: streamed }))).toBe("LinkThumbTooLarge");
  });

  it("ignores the preview's HTML cap in the shared options", async () => {
    const options = { ...png(), maxBytes: 4 };
    expect(Exit.isSuccess(await run({ options }))).toBe(true);
  });

  it("a repeat comes from the cache: no fetch, no transform, still private", async () => {
    const cache = cacheStub();
    const images = imagesStub();
    const options = png();
    await withCaches(cache.caches, async () => {
      const first = await run({ options, images });
      expect(Exit.isSuccess(first)).toBe(true);
      const second = await run({ options, images });
      const res = (second as Exit.Success<Response>).value;
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(TRANSFORMED);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
    expect(options.fetched).toHaveLength(1);
    expect(images.calls).toHaveLength(1);
    // The key names neither the shop nor its URL.
    const [key] = [...cache.store.keys()];
    expect(key).not.toContain("shop.example");
    expect(key).toContain("wed_1");
  });

  it("keeps one wedding's cached thumbnails from another's", async () => {
    const cache = cacheStub();
    const images = imagesStub();
    const options = png();
    await withCaches(cache.caches, async () => {
      await run({ options, images });
      await run({ options, images, weddingId: "wed_2" });
    });
    expect(options.fetched).toHaveLength(2);
  });

  it("does not cache the un-encoded local path", async () => {
    const cache = cacheStub();
    await withCaches(cache.caches, () => run({ options: png() }));
    expect(cache.store.size).toBe(0);
  });
});
