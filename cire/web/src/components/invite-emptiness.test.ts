import { describe, it, expect } from "vitest";

import { hasDressCode, hasPinterest, hasText, isHeroEmpty, isStoryEmpty } from "./invite-emptiness";

describe("hasText", () => {
  it("is false for null, undefined, empty, and whitespace-only", () => {
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
    expect(hasText("")).toBe(false);
    expect(hasText("   ")).toBe(false);
    expect(hasText("\t\n ")).toBe(false);
  });

  it("is true for any non-whitespace text", () => {
    expect(hasText("x")).toBe(true);
    expect(hasText("  padded  ")).toBe(true);
  });
});

describe("isHeroEmpty", () => {
  const empty = { imageUrl: null, title: null, subtitle: null };

  it("is empty only when image, title and subtitle are all absent", () => {
    expect(isHeroEmpty(empty)).toBe(true);
    expect(isHeroEmpty({ ...empty, title: "  " })).toBe(true); // whitespace-only ⇒ absent
  });

  it("is NOT empty with an image only", () => {
    expect(isHeroEmpty({ ...empty, imageUrl: "/img" })).toBe(false);
  });

  it("is NOT empty with a title only", () => {
    expect(isHeroEmpty({ ...empty, title: "A & B" })).toBe(false);
  });

  it("is NOT empty with a subtitle only", () => {
    expect(isHeroEmpty({ ...empty, subtitle: "Save the date" })).toBe(false);
  });
});

describe("isStoryEmpty", () => {
  const empty = { heading: null, body: null, imageUrl: null };

  it("is empty when heading, body and image are all absent", () => {
    expect(isStoryEmpty(empty)).toBe(true);
    expect(isStoryEmpty({ heading: " ", body: "", imageUrl: null })).toBe(true);
  });

  it("is NOT empty with any one of heading / body / image", () => {
    expect(isStoryEmpty({ ...empty, heading: "How It Began" })).toBe(false);
    expect(isStoryEmpty({ ...empty, body: "Once upon a time" })).toBe(false);
    expect(isStoryEmpty({ ...empty, imageUrl: "/img" })).toBe(false);
  });
});

describe("hasPinterest", () => {
  it("is false for absent / whitespace-only URLs", () => {
    expect(hasPinterest(null)).toBe(false);
    expect(hasPinterest("   ")).toBe(false);
  });

  it("is true for a real URL", () => {
    expect(hasPinterest("https://pinterest.com/x")).toBe(true);
  });
});

describe("hasDressCode", () => {
  it("is false with no description and an empty / null palette", () => {
    expect(hasDressCode(null, null)).toBe(false);
    expect(hasDressCode("  ", [])).toBe(false);
  });

  it("is true with a description", () => {
    expect(hasDressCode("Black tie", null)).toBe(true);
  });

  it("is true with at least one palette swatch", () => {
    expect(hasDressCode(null, [{ name: "Gold", color: "#d4af37" }])).toBe(true);
  });
});
