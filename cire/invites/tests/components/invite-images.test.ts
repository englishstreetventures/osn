import { describe, expect, it } from "vitest";

import { buildSrcSet, heroPreloadHref, variantSrc } from "../../src/components/invite-images";

describe("buildSrcSet (T-M1)", () => {
  it("appends &variant=…<width>w for each variant when the base URL already has a query", () => {
    // Base ends with the ?v= content-version cache-buster, so the separator for
    // the appended &variant= must be `&` (not a second `?`).
    const srcset = buildSrcSet("/api/invite/s/image/hero?v=123", ["thumb", "card", "hero"]);
    expect(srcset).toBe(
      "/api/invite/s/image/hero?v=123&variant=thumb 320w, " +
        "/api/invite/s/image/hero?v=123&variant=card 800w, " +
        "/api/invite/s/image/hero?v=123&variant=hero 1600w",
    );
  });

  it("uses ? as the first separator when the base URL has no query", () => {
    const srcset = buildSrcSet("/img", ["thumb", "card"]);
    expect(srcset).toBe("/img?variant=thumb 320w, /img?variant=card 800w");
  });

  it("emits the correct width descriptor for each named variant", () => {
    expect(buildSrcSet("/x?v=1", ["hero"])).toBe("/x?v=1&variant=hero 1600w");
  });
});

describe("variantSrc", () => {
  it("appends a single bounded &variant= when the base URL already has a query", () => {
    expect(variantSrc("/api/invite/s/image/hero?v=123", "hero-bg")).toBe(
      "/api/invite/s/image/hero?v=123&variant=hero-bg",
    );
  });

  it("uses ? when the base URL has no query", () => {
    expect(variantSrc("/img", "hero-bg")).toBe("/img?variant=hero-bg");
  });
});

describe("heroPreloadHref", () => {
  const API = "https://api.test";
  const hero = (over: Partial<{ imageUrl: string | null; title: string | null }> = {}) => ({
    imageUrl: "/api/invite/s/image/hero?v=9",
    title: null,
    subtitle: null,
    ...over,
  });

  // The exact URL InviteHeader renders: the single blurred backdrop variant.
  it("preloads the hero-bg variant of a shown hero's image", () => {
    expect(heroPreloadHref(API, { hero: hero(), visibility: { hero: true } })).toBe(
      "https://api.test/api/invite/s/image/hero?v=9&variant=hero-bg",
    );
  });

  it("reads a payload without the switch as on", () => {
    expect(heroPreloadHref(API, { hero: hero() })).toBe(
      "https://api.test/api/invite/s/image/hero?v=9&variant=hero-bg",
    );
  });

  // A switched-off hero renders nothing, so its image must not be fetched at
  // top priority either.
  it("preloads nothing for a switched-off hero, image or not", () => {
    expect(heroPreloadHref(API, { hero: hero(), visibility: { hero: false } })).toBeNull();
  });

  it("preloads nothing without a hero image, or without a payload", () => {
    expect(heroPreloadHref(API, { hero: hero({ imageUrl: null, title: "A & B" }) })).toBeNull();
    expect(heroPreloadHref(API, null)).toBeNull();
  });
});
