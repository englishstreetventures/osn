import { describe, expect, it } from "bun:test";

import { linkThumbTransforms } from "@cire/db";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
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

function run(
  over: Partial<LinkThumbnailArgs> & { options: LinkPreviewOptions },
  db: ReturnType<typeof createDb> = createDb(),
) {
  return Effect.runPromiseExit(
    linkThumbnailService
      .thumbnail({
        request: new Request("https://api.test/thumb", { method: "POST" }),
        rawUrl: "https://cdn.shop.example/pan.png",
        format: "image/webp",
        requireTransform: false,
        ...over,
      })
      .pipe(Effect.provideService(DbService, db)),
  );
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

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

  it("maps an upstream error status and a redirect loop to a fetch failure", async () => {
    const notFound = remote(() => new Response("gone", { status: 404 }));
    expect(failTag(await run({ options: notFound }))).toBe("LinkThumbFetchFailed");

    const loop = remote(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.shop.example/again" },
        }),
    );
    expect(failTag(await run({ options: loop }))).toBe("LinkThumbFetchFailed");
  });

  it("maps a body that breaks off mid-stream to a fetch failure, not a defect", async () => {
    const broken = remote(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.error(new Error("reset"));
            },
          }),
        ),
    );
    expect(failTag(await run({ options: broken }))).toBe("LinkThumbFetchFailed");
  });

  it("refuses an empty body on its signature", async () => {
    const empty = remote(() => new Response(new Uint8Array(0)));
    expect(failTag(await run({ options: empty }))).toBe("LinkThumbUnsupportedType");
  });

  it("ignores the preview's HTML cap in the shared options", async () => {
    const options = { ...png(), maxBytes: 4 };
    expect(Exit.isSuccess(await run({ options }))).toBe(true);
  });

  it("a repeat comes from the cache: no fetch, no transform, still private", async () => {
    const cache = cacheStub();
    const images = imagesStub();
    const options = png();
    const ok = await counterValue(CIRE_METRICS.registryLinkThumb, { result: "ok" });
    const hits = await counterValue(CIRE_METRICS.registryLinkThumb, { result: "cache_hit" });
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
    expect(await counterValue(CIRE_METRICS.registryLinkThumb, { result: "ok" })).toBe(ok + 1);
    expect(await counterValue(CIRE_METRICS.registryLinkThumb, { result: "cache_hit" })).toBe(
      hits + 1,
    );
    // The key names neither the shop nor its URL.
    const [key] = [...cache.store.keys()];
    expect(key).not.toContain("shop.example");
  });

  it("keys on the url and the format", async () => {
    const cache = cacheStub();
    const images = imagesStub();
    const options = png();
    await withCaches(cache.caches, async () => {
      await run({ options, images });
      await run({ options, images, format: "image/avif" });
      await run({ options, images, rawUrl: "https://cdn.shop.example/other.png" });
    });
    expect(options.fetched).toHaveLength(3);
    expect(images.calls.map((c) => c.format)).toEqual(["image/webp", "image/avif", "image/webp"]);
  });

  it("answers the thumbnail even when the cache refuses to store it", async () => {
    const refusing = {
      default: {
        match: () => Promise.resolve(undefined),
        put: () => Promise.reject(new Error("413")),
      },
    } as unknown as CacheStorage;
    const exit = await withCaches(refusing, () => run({ options: png(), images: imagesStub() }));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("charges one transform per miss against this month's budget, and none on a hit", async () => {
    const db = createDb();
    const cache = cacheStub();
    const images = imagesStub();
    await withCaches(cache.caches, async () => {
      await run({ options: png(), images }, db);
      await run({ options: png(), images }, db);
      await run({ options: png(), images, rawUrl: "https://cdn.shop.example/b.png" }, db);
    });
    expect(db.select().from(linkThumbTransforms).all()).toEqual([{ period: thisMonth(), used: 2 }]);
  });

  it("refuses before any fetch once the month's budget is spent", async () => {
    const db = createDb();
    db.insert(linkThumbTransforms).values({ period: thisMonth(), used: 3 }).run();
    const options = png();
    const images = imagesStub();
    const exit = await run({ options, images, monthlyTransforms: 3 }, db);
    expect(failTag(exit)).toBe("LinkThumbBudgetSpent");
    expect(options.fetched).toEqual([]);
    expect(images.calls).toEqual([]);
  });

  it("spends the last transform once, and refuses the next", async () => {
    const db = createDb();
    db.insert(linkThumbTransforms).values({ period: thisMonth(), used: 1 }).run();
    const images = imagesStub();
    const first = await run({ options: png(), images, monthlyTransforms: 2 }, db);
    expect(Exit.isSuccess(first)).toBe(true);
    const second = await run(
      { options: png(), images, monthlyTransforms: 2, rawUrl: "https://cdn.shop.example/c.png" },
      db,
    );
    expect(failTag(second)).toBe("LinkThumbBudgetSpent");
    expect(images.calls).toHaveLength(1);
    expect(db.select().from(linkThumbTransforms).all()).toEqual([{ period: thisMonth(), used: 2 }]);
  });

  it("spends no budget on the local path, which runs no transform", async () => {
    const db = createDb();
    await run({ options: png() }, db);
    expect(db.select().from(linkThumbTransforms).all()).toEqual([]);
  });

  it("does not cache the un-encoded local path", async () => {
    const cache = cacheStub();
    await withCaches(cache.caches, () => run({ options: png() }));
    expect(cache.store.size).toBe(0);
  });
});
