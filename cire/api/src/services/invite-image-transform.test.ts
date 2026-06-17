import { describe, it, expect } from "bun:test";

import { Effect, Exit } from "effect";

import type { StoredAsset } from "./invite-assets";
import {
  buildTransformCacheKey,
  DEFAULT_VARIANT,
  IMAGE_VARIANTS,
  negotiateFormat,
  resolveVariant,
  transformAsset,
  type ImagesBindingLike,
  type ImageTransformHandle,
  type OutputFormat,
} from "./invite-image-transform";

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
    // After the S-M1 fix the version is the server-side row `updatedAt` epoch ms,
    // not the client `?v=`. Two different versions must yield different keys so a
    // re-uploaded image isn't served the stale cached transform.
    const base = { slug: "s", slot: "hero", variant: "card", format: "image/jpeg" } as const;
    const v1 = buildTransformCacheKey({ ...base, version: "1718000000000" });
    const v2 = buildTransformCacheKey({ ...base, version: "1718999999999" });
    expect(v1.url).not.toBe(v2.url);
    expect(new URL(v1.url).searchParams.get("v")).toBe("1718000000000");
    expect(new URL(v2.url).searchParams.get("v")).toBe("1718999999999");
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
  calls: { width?: number; format?: OutputFormat }[];
} {
  const calls: { width?: number; format?: OutputFormat }[] = [];
  return {
    calls,
    input(_stream) {
      if (opts?.throwOn === "input") throw new Error("input boom");
      const handle: ImageTransformHandle = {
        transform(t) {
          calls.push({ width: t.width });
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
  it("runs the original through the binding at the variant width + format", async () => {
    const images = createImagesStub();
    const out = await Effect.runPromise(transformAsset(images, ORIGINAL, "hero", "image/avif"));
    expect(images.calls).toEqual([{ width: IMAGE_VARIANTS.hero, format: "image/avif" }]);
    expect(out.contentType).toBe("image/avif");
    expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array([9, 9, 9]));
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
