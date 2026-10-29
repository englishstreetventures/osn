import { describe, expect, it } from "bun:test";

import { slugifyDisplayName } from "../../src/lib/slug";

describe("slugifyDisplayName", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugifyDisplayName("Nadia & Sam")).toBe("nadia-sam");
  });

  it("strips accents and apostrophes into hyphen-joined ASCII", () => {
    expect(slugifyDisplayName("Pádraig's Big Day")).toBe("padraig-s-big-day");
  });

  it("trims leading/trailing separators", () => {
    expect(slugifyDisplayName("  --Hello--  ")).toBe("hello");
  });

  it("falls back to 'wedding' for slug-empty input", () => {
    expect(slugifyDisplayName("🎉💍")).toBe("wedding");
    expect(slugifyDisplayName("")).toBe("wedding");
  });

  it("cuts the base slug to 60 characters", () => {
    expect(slugifyDisplayName("a".repeat(200))).toBe("a".repeat(60));
  });

  it("drops a hyphen the cut leaves at the end", () => {
    // The 60th character is the separator, so the cut ends on a hyphen; left
    // there, the guest link would read `…x--<suffix>`.
    expect(slugifyDisplayName(`${"x".repeat(59)} y`)).toBe("x".repeat(59));
  });
});
