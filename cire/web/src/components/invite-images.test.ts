import { describe, expect, it } from "vitest";

import { buildSrcSet, variantSrc } from "./invite-images";

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
