import { describe, it, expect, afterEach } from "bun:test";

import { Effect, Exit } from "effect";

import { CIRE_METRICS } from "../../src/metrics";
import type { StoredAsset } from "../../src/services/invite-assets";
import { AssetsR2Service, createAssetsStub } from "../../src/services/invite-assets";
import {
  blurForVariant,
  buildTransformCacheKey,
  DEFAULT_VARIANT,
  IMAGE_VARIANTS,
  imageCacheControl,
  negotiateFormat,
  resolveVariant,
  REVOCABLE_MAX_AGE_S,
  serveTransformedImage,
  transformAsset,
  VARIANT_BLUR,
  type ImageClientLifetime,
  type ImagesBindingLike,
  type ImageTransformHandle,
  type OutputFormat,
} from "../../src/services/invite-image-transform";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";

describe("resolveVariant", () => {
  it("returns a known variant verbatim", () => {
    expect(resolveVariant("thumb")).toBe("thumb");
    expect(resolveVariant("card")).toBe("card");
    expect(resolveVariant("hero")).toBe("hero");
  });

  it("collapses missing/unknown values to the default (bounds cardinality)", () => {
    expect(resolveVariant(null)).toBe(DEFAULT_VARIANT);
    expect(resolveVariant(undefined)).toBe(DEFAULT_VARIANT);
    expect(resolveVariant("")).toBe(DEFAULT_VARIANT);
    expect(resolveVariant("999")).toBe(DEFAULT_VARIANT);
    expect(resolveVariant("../../etc/passwd")).toBe(DEFAULT_VARIANT);
  });

  it("accepts the blurred hero-bg variant but keeps the allowlist bounded", () => {
    // hero-bg is a known variant (so the blurred backdrop resolves), but the set
    // stays bounded — an attacker still can't mint an arbitrary blur/width.
    expect(resolveVariant("hero-bg")).toBe("hero-bg");
    expect(Object.keys(IMAGE_VARIANTS).toSorted()).toEqual(["card", "hero", "hero-bg", "thumb"]);
    // A near-miss (blur sweep attempt) collapses to the default, not a new entry.
    expect(resolveVariant("hero-bg-50")).toBe(DEFAULT_VARIANT);
    expect(resolveVariant("blur")).toBe(DEFAULT_VARIANT);
  });
});

describe("blurForVariant", () => {
  it("blurs ONLY the hero-bg backdrop, with a server-side radius", () => {
    expect(blurForVariant("hero-bg")).toBe(VARIANT_BLUR["hero-bg"]);
    expect(blurForVariant("hero-bg")).toBeGreaterThan(0);
  });

  it("leaves the sharp variants (thumb/card/hero) un-blurred", () => {
    expect(blurForVariant("thumb")).toBeUndefined();
    expect(blurForVariant("card")).toBeUndefined();
    expect(blurForVariant("hero")).toBeUndefined();
  });
});

describe("negotiateFormat", () => {
  it("prefers AVIF, then WebP, then JPEG by Accept", () => {
    expect(negotiateFormat("image/avif,image/webp,*/*")).toBe("image/avif");
    expect(negotiateFormat("image/webp,*/*")).toBe("image/webp");
    expect(negotiateFormat("image/png,*/*")).toBe("image/jpeg");
  });

  it("falls back to JPEG when Accept is missing", () => {
    expect(negotiateFormat(null)).toBe("image/jpeg");
    expect(negotiateFormat(undefined)).toBe("image/jpeg");
    expect(negotiateFormat("")).toBe("image/jpeg");
  });
});

describe("buildTransformCacheKey", () => {
  const keyUrl = (args: Parameters<typeof buildTransformCacheKey>[0]) =>
    new URL(buildTransformCacheKey(args).url);

  it("bakes slug, slot, variant and format into a stable GET key", () => {
    const req = buildTransformCacheKey({
      slug: "cire-wedding",
      slot: "hero",
      variant: "hero",
      format: "image/avif",
    });
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/cire-wedding/hero");
    expect(url.searchParams.get("variant")).toBe("hero");
    expect(url.searchParams.get("format")).toBe("avif");
  });

  it("is identical for identical inputs (cache hits land)", () => {
    const a = buildTransformCacheKey({
      slug: "s",
      slot: "hero",
      variant: "card",
      format: "image/webp",
    });
    const b = buildTransformCacheKey({
      slug: "s",
      slot: "hero",
      variant: "card",
      format: "image/webp",
    });
    expect(a.url).toBe(b.url);
  });

  it("differs by format so AVIF/WebP/JPEG are cached apart", () => {
    const base = { slug: "s", slot: "hero", variant: "card" } as const;
    const avif = keyUrl({ ...base, format: "image/avif" }).searchParams.get("format");
    const webp = keyUrl({ ...base, format: "image/webp" }).searchParams.get("format");
    const jpeg = keyUrl({ ...base, format: "image/jpeg" }).searchParams.get("format");
    expect(new Set([avif, webp, jpeg]).size).toBe(3);
  });

  it("differs by version so a re-upload (bumped updatedAt) mints a fresh entry (T-S1)", () => {
    // The version is the server-side row `updatedAt` epoch ms, not the client
    // `?v=`. Two different versions must yield different keys so a re-uploaded
    // image isn't served the stale cached transform.
    const base = { slug: "s", slot: "hero", variant: "card", format: "image/jpeg" } as const;
    const v1 = buildTransformCacheKey({ ...base, version: "1718000000000" });
    const v2 = buildTransformCacheKey({ ...base, version: "1718999999999" });
    expect(v1.url).not.toBe(v2.url);
    expect(new URL(v1.url).searchParams.get("v")).toBe("1718000000000");
    expect(new URL(v2.url).searchParams.get("v")).toBe("1718999999999");
  });

  it("folds the per-wedding blur into the key so two blurs are cached apart (0018)", () => {
    const base = { slug: "s", slot: "hero", variant: "hero-bg", format: "image/webp" } as const;
    const b28 = buildTransformCacheKey({ ...base, blur: 28 });
    const b5 = buildTransformCacheKey({ ...base, blur: 5 });
    expect(b28.url).not.toBe(b5.url);
    expect(new URL(b28.url).searchParams.get("blur")).toBe("28");
    expect(new URL(b5.url).searchParams.get("blur")).toBe("5");
    // An explicit 0 (sharp) is still keyed (distinct from "no blur folded in").
    const b0 = buildTransformCacheKey({ ...base, blur: 0 });
    expect(new URL(b0.url).searchParams.get("blur")).toBe("0");
    // Absent blur ⇒ no blur param (sharp variants don't carry one).
    const none = buildTransformCacheKey({
      slug: "s",
      slot: "hero",
      variant: "card",
      format: "image/webp",
    });
    expect(new URL(none.url).searchParams.get("blur")).toBeNull();
  });

  it("differs by variant and includes the ?v= content version when present", () => {
    const card = buildTransformCacheKey({
      slug: "s",
      slot: "hero",
      variant: "card",
      format: "image/jpeg",
    });
    const hero = buildTransformCacheKey({
      slug: "s",
      slot: "hero",
      variant: "hero",
      format: "image/jpeg",
    });
    expect(card.url).not.toBe(hero.url);

    const versioned = keyUrl({
      slug: "s",
      slot: "hero",
      variant: "card",
      format: "image/jpeg",
      version: "1718000000",
    });
    expect(versioned.searchParams.get("v")).toBe("1718000000");
  });
});

const ORIGINAL: StoredAsset = {
  bytes: new Uint8Array([1, 2, 3, 4]).buffer,
  contentType: "image/png",
};

/** Stub binding that records the transform args and returns canned bytes. */
function createImagesStub(opts?: { throwOn?: "input" | "output" }): ImagesBindingLike & {
  calls: { width?: number; blur?: number; format?: OutputFormat }[];
} {
  const calls: { width?: number; blur?: number; format?: OutputFormat }[] = [];
  return {
    calls,
    input(_stream) {
      if (opts?.throwOn === "input") throw new Error("input boom");
      const handle: ImageTransformHandle = {
        transform(t) {
          calls.push({ width: t.width, blur: t.blur });
          return handle;
        },
        output(o) {
          if (opts?.throwOn === "output") return Promise.reject(new Error("output boom"));
          if (calls.length > 0) calls[calls.length - 1]!.format = o.format;
          return Promise.resolve({
            response: () =>
              new Response(new Uint8Array([9, 9, 9]), { headers: { "Content-Type": o.format } }),
            contentType: () => o.format,
          });
        },
      };
      return handle;
    },
  };
}

describe("transformAsset", () => {
  it("runs the original through the binding at the variant width + format (no blur for sharp variants)", async () => {
    const images = createImagesStub();
    const out = await Effect.runPromise(transformAsset(images, ORIGINAL, "hero", "image/avif"));
    expect(images.calls).toEqual([
      { width: IMAGE_VARIANTS.hero, blur: undefined, format: "image/avif" },
    ]);
    // The sharp `hero` variant carries NO blur (it's the crisp full-res hero).
    expect(images.calls[0]!.blur).toBeUndefined();
    expect(out.contentType).toBe("image/avif");
    expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("applies the server-side blur for the hero-bg backdrop variant (T-B1)", async () => {
    const images = createImagesStub();
    await Effect.runPromise(transformAsset(images, ORIGINAL, "hero-bg", "image/webp"));
    // hero-bg renders at the hero width WITH the server-chosen blur radius.
    expect(images.calls).toEqual([
      { width: IMAGE_VARIANTS["hero-bg"], blur: VARIANT_BLUR["hero-bg"], format: "image/webp" },
    ]);
    expect(images.calls[0]!.blur).toBe(VARIANT_BLUR["hero-bg"]);
    expect(images.calls[0]!.blur).toBeGreaterThan(0);
  });

  it("honours the per-wedding blur override on the hero-bg variant, incl. an explicit 0 (0018)", async () => {
    const override = createImagesStub();
    await Effect.runPromise(transformAsset(override, ORIGINAL, "hero-bg", "image/webp", 7));
    // The override (7) wins over the VARIANT_BLUR default.
    expect(override.calls[0]!.blur).toBe(7);

    // An explicit 0 ⇒ a SHARP backdrop (no blur passed to the binding), even on
    // the hero-bg variant — distinct from `undefined` which uses the default.
    const sharp = createImagesStub();
    await Effect.runPromise(transformAsset(sharp, ORIGINAL, "hero-bg", "image/webp", 0));
    expect(sharp.calls[0]!.blur).toBeUndefined();
  });

  it("ignores a blur override on a sharp variant (stays un-blurred)", async () => {
    // The override only applies where the variant is blurrable (hero-bg); a sharp
    // variant never gets a blur even if an override is (wrongly) passed.
    const images = createImagesStub();
    await Effect.runPromise(transformAsset(images, ORIGINAL, "hero", "image/webp", 30));
    expect(images.calls[0]!.blur).toBeUndefined();
  });

  it("fails with ImageTransformError when the binding throws at input", async () => {
    const images = createImagesStub({ throwOn: "input" });
    const exit = await Effect.runPromiseExit(
      transformAsset(images, ORIGINAL, "card", "image/webp"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails with ImageTransformError when output rejects", async () => {
    const images = createImagesStub({ throwOn: "output" });
    const exit = await Effect.runPromiseExit(
      transformAsset(images, ORIGINAL, "card", "image/webp"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("imageCacheControl", () => {
  it("gives the default lifetime a year, never revalidated", () => {
    expect(imageCacheControl("public", "immutable")).toBe("public, max-age=31536000, immutable");
    expect(imageCacheControl("private", "immutable")).toBe("private, max-age=31536000, immutable");
  });

  it("gives a revocable image an hour and drops `immutable`", () => {
    expect(REVOCABLE_MAX_AGE_S).toBe(3600);
    expect(imageCacheControl("public", "revocable")).toBe("public, max-age=3600");
    // Visibility still comes from the slot: a gated revocable image stays `private`.
    expect(imageCacheControl("private", "revocable")).toBe("private, max-age=3600");
  });
});

describe("serveTransformedImage — what the cache is handed vs what the client gets", () => {
  const KEY = "assets/wed_1/registry-abc";

  /**
   * Minimal `caches.default`: one slot, and a record of what was put into it.
   *
   * `storedFor` makes a hit look like one the platform returns for an entry
   * stored that many seconds ago — an `Age` of that many seconds and the `Date`
   * of the store — which is what a short client lifetime has to survive.
   */
  function createCacheStub(opts: { storedFor?: number } = {}) {
    const puts: Response[] = [];
    let stored: Response | null = null;
    function aged(res: Response): Response {
      if (opts.storedFor === undefined) return res;
      const headers = new Headers(res.headers);
      headers.set("Age", String(opts.storedFor));
      headers.set("Date", new Date(Date.now() - opts.storedFor * 1000).toUTCString());
      return new Response(res.body, { status: res.status, headers });
    }
    return {
      puts,
      binding: {
        default: {
          match: (_key: Request) => Promise.resolve(stored ? aged(stored.clone()) : undefined),
          put: (_key: Request, res: Response) => {
            puts.push(res.clone());
            stored = res;
            return Promise.resolve();
          },
        },
      },
    };
  }

  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  async function serve(visibility: "public" | "private", lifetime?: ImageClientLifetime) {
    const assets = createAssetsStub();
    await assets.put(KEY, new Uint8Array([1, 2, 3]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    return Effect.runPromise(
      serveTransformedImage({
        request: new Request("https://api.example/organiser/registry/image/registry-abc"),
        key: KEY,
        version: "1718000000",
        cacheSlot: "registry:wed_1",
        logSlot: "registry",
        variant: "thumb",
        format: "image/jpeg",
        visibility,
        lifetime,
      }).pipe(Effect.provideService(AssetsR2Service, assets)),
    );
  }

  it("stores a public copy of a private image while telling the client `private`", async () => {
    // Cloudflare's cache refuses to store a `private` response, so a gated slot
    // would pay for the transform on every single request. The stored copy is
    // storable; the served one is not, and the key it sits under is synthetic.
    const cache = createCacheStub();
    (globalThis as { caches?: unknown }).caches = cache.binding;

    const res = await serve("private");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("leaves a public image saying `public` on both copies", async () => {
    const cache = createCacheStub();
    (globalThis as { caches?: unknown }).caches = cache.binding;

    const res = await serve("public");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(cache.puts[0]!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("re-stamps a public HIT with the same year the miss carried", async () => {
    const cache = createCacheStub();
    (globalThis as { caches?: unknown }).caches = cache.binding;

    await serve("public");
    const hit = await serve("public");
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(cache.puts).toHaveLength(1);
  });

  it("tells the client an hour for a revocable image, and still stores a year", async () => {
    // The stored copy is looked up only after the route's gate, so it can live
    // as long as the bytes do. What must be short is the copy outside the
    // Worker, which no gate ever sees again.
    const cache = createCacheStub();
    (globalThis as { caches?: unknown }).caches = cache.binding;

    const res = await serve("public", "revocable");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(cache.puts[0]!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("re-stamps a revocable HIT with the hour, not the stored year", async () => {
    const cache = createCacheStub();
    (globalThis as { caches?: unknown }).caches = cache.binding;

    await serve("public", "revocable");
    const hit = await serve("public", "revocable");
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(cache.puts).toHaveLength(1);
  });

  it("hands a hit to the client as fresh, whatever age the stored copy has", async () => {
    // An entry stored two hours ago comes back with `Age: 7200` and a two-hour-
    // old `Date`. Passed through, either one makes an hour-long response stale
    // on arrival, and the browser would fetch every gift image again on every
    // page load.
    const cache = createCacheStub({ storedFor: 7200 });
    (globalThis as { caches?: unknown }).caches = cache.binding;

    await serve("public", "revocable");
    const before = Date.now();
    const hit = await serve("public", "revocable");
    expect(hit.headers.get("Age")).toBeNull();
    const date = Date.parse(hit.headers.get("Date") ?? "");
    // `Date` has one-second resolution, so allow the second it was cut from.
    expect(date).toBeGreaterThanOrEqual(before - 1000);
    expect(date).toBeLessThanOrEqual(Date.now());
  });

  it("re-stamps a cache HIT with the slot's real visibility", async () => {
    // Otherwise the second request for a private image would tell the browser it
    // was shareable, purely because the first one had been cached.
    const cache = createCacheStub();
    (globalThis as { caches?: unknown }).caches = cache.binding;

    await serve("private");
    const hit = await serve("private");
    expect(hit.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    // Served from the stored copy — the transform path was not re-entered.
    expect(cache.puts).toHaveLength(1);
  });

  it("serves the image even when the cache refuses the put", async () => {
    // A refused put is a missed cache, not a failed request — and it must not
    // surface as an unhandled rejection either.
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: () => Promise.resolve(undefined),
        put: () => Promise.reject(new Error("Cache put: Response body is unbuffered")),
      },
    };
    const res = await serve("private");
    expect(res.status).toBe(200);
  });

  it("logs the slot kind, never the wedding slug, when the transform and the put both fail", async () => {
    // The public routes build `cacheSlot` from the slug, which is the couple's
    // names. Both warnings on this path must name the slot kind instead.
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: () => Promise.resolve(undefined),
        // A workerd refusal could echo the key (a URL holding the slug) in its message.
        put: () => Promise.reject(new Error("Cache put: refused anna-and-ben")),
      },
    };
    const assets = createAssetsStub();
    await assets.put(KEY, new Uint8Array([1, 2, 3]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    const logs = await captureLogs(() =>
      Effect.runPromise(
        serveTransformedImage({
          request: new Request("https://api.example/invite/anna-and-ben/image/story"),
          key: KEY,
          version: "1718000000",
          cacheSlot: "anna-and-ben:story",
          logSlot: "story",
          variant: "thumb",
          format: "image/webp",
          images: createImagesStub({ throwOn: "output" }),
        }).pipe(Effect.provideService(AssetsR2Service, assets)),
      ),
    );

    expect(logs).toContain("invite image transform failed; serving original");
    expect(logs).toContain("image cache put failed");
    // Both warnings carry the slot kind as a field.
    expect(logs.match(/"?slot"?[:=] ?"?story/g)?.length ?? 0).toBe(2);
    expect(logs).not.toContain("anna-and-ben");
    expect(logs).not.toContain("Cache put: refused");
  });
});

describe("serveTransformedImage — revalidating a revocable image", () => {
  const KEY = "assets/wed_1/registry-abc";
  const VERSION = "5f3a9c1e";
  const TAG = `W/"${VERSION}-thumb-jpeg"`;

  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  const notModified = () =>
    counterValue(CIRE_METRICS.imageTransform, {
      result: "not_modified",
      variant: "thumb",
      format: "image/jpeg",
    });

  /**
   * Everything a full answer would spend, counted. `stored` prefills the
   * Worker cache, as an entry written by an earlier deploy would be.
   */
  function harness(stored: Response | null = null) {
    const assets = createAssetsStub();
    const spent = { r2: 0, match: 0, transforms: 0 };
    const get = assets.get.bind(assets);
    assets.get = (key: string) => {
      spent.r2 += 1;
      return get(key);
    };
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: () => {
          spent.match += 1;
          return Promise.resolve(stored?.clone());
        },
        put: (_key: Request, res: Response) => {
          stored = res;
          return Promise.resolve();
        },
      },
    };
    const images: ImagesBindingLike = {
      input() {
        const handle: ImageTransformHandle = {
          transform: () => handle,
          output: ({ format }) => {
            spent.transforms += 1;
            return Promise.resolve({
              response: () =>
                new Response(new Uint8Array([9, 9]), { headers: { "Content-Type": format } }),
              contentType: () => format,
            });
          },
        };
        return handle;
      },
    };
    return { assets, spent, images };
  }

  async function serve(
    h: ReturnType<typeof harness>,
    opts: {
      ifNoneMatch?: string;
      lifetime?: ImageClientLifetime;
      withImages?: boolean;
    } = {},
  ) {
    await h.assets.put(KEY, new Uint8Array([1, 2, 3]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    const headers = new Headers();
    if (opts.ifNoneMatch !== undefined) headers.set("If-None-Match", opts.ifNoneMatch);
    return Effect.runPromise(
      serveTransformedImage({
        request: new Request("https://api.example/api/invite/s/registry/image/registry-abc", {
          headers,
        }),
        key: KEY,
        version: VERSION,
        cacheSlot: "s:registry:registry-abc",
        logSlot: "registry",
        variant: "thumb",
        format: "image/jpeg",
        visibility: "public",
        lifetime: opts.lifetime ?? "revocable",
        images: opts.withImages === false ? undefined : h.images,
      }).pipe(Effect.provideService(AssetsR2Service, h.assets)),
    );
  }

  it("names what it served with a weak tag, on the miss, the hit and the original path", async () => {
    const h = harness();
    const miss = await serve(h);
    expect(miss.headers.get("ETag")).toBe(TAG);
    const hit = await serve(h);
    expect(h.spent.transforms).toBe(1);
    expect(hit.headers.get("ETag")).toBe(TAG);

    const original = await serve(harness(), { withImages: false });
    expect(original.headers.get("ETag")).toBe(TAG);
  });

  it("tags a Worker-cache hit stored before tags existed, and untags an immutable one", async () => {
    // The Worker cache keeps an entry for a year, so every copy stored before
    // this tag existed comes back without one. The hit is re-stamped from the
    // slot, never trusted from the store.
    const untagged = new Response(new Uint8Array([7]), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000" },
    });
    const h = harness(untagged);
    const hit = await serve(h);
    expect(hit.headers.get("ETag")).toBe(TAG);
    expect(h.spent.transforms).toBe(0);
    expect(h.spent.r2).toBe(0);

    const tagged = new Response(new Uint8Array([7]), {
      headers: { "Content-Type": "image/jpeg", ETag: TAG },
    });
    const immutable = await serve(harness(tagged), { lifetime: "immutable" });
    expect(immutable.headers.get("ETag")).toBeNull();
  });

  it("answers a matching If-None-Match with 304 and spends nothing else", async () => {
    // The browser's hour is up and it asks again with the tag it holds. The
    // bytes under a key never change, so the gate the route already ran is the
    // only thing worth paying for.
    const h = harness();
    const before = await notModified();
    const res = await serve(h, { ifNoneMatch: TAG });
    expect(await notModified()).toBe(before + 1);
    expect(res.status).toBe(304);
    expect(await res.arrayBuffer()).toHaveProperty("byteLength", 0);
    expect(res.headers.get("ETag")).toBe(TAG);
    // Another hour for the copy the browser already has, and the same Vary, so
    // it refreshes the entry it asked about and no other.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Vary")).toBe("Accept, Origin");
    expect(h.spent).toEqual({ r2: 0, match: 0, transforms: 0 });
  });

  it("matches the tag inside a list, and whichever way the weak marker is spelt", async () => {
    for (const header of [
      `"other", ${TAG}`,
      `${TAG},"other"`,
      `"${VERSION}-thumb-jpeg"`,
      `  ${TAG}  `,
    ]) {
      expect((await serve(harness(), { ifNoneMatch: header })).status).toBe(304);
    }
  });

  it("answers in full when the tag held is another one", async () => {
    // A different variant, a different format, a different image, a wildcard
    // (no browser sends one on a GET; the full answer is the safe side).
    for (const header of [
      `W/"${VERSION}-card-jpeg"`,
      `W/"${VERSION}-thumb-webp"`,
      `W/"00000000-thumb-jpeg"`,
      "*",
      "",
    ]) {
      const h = harness();
      const before = await notModified();
      const res = await serve(h, { ifNoneMatch: header });
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBe(TAG);
      expect(await notModified()).toBe(before);
    }
  });

  it("leaves every immutable image as it was: no tag, and no 304", async () => {
    // A year-long image is never revalidated, so a tag would be bytes on every
    // response for nothing — and the three other routes stay exactly as they are.
    const h = harness();
    const res = await serve(h, { lifetime: "immutable", ifNoneMatch: TAG });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    const hit = await serve(h, { lifetime: "immutable" });
    expect(hit.headers.get("ETag")).toBeNull();
  });
});
