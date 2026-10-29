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

  it("caps the base slug length", () => {
    const long = "a".repeat(200);
    expect(slugifyDisplayName(long).length).toBeLessThanOrEqual(60);
  });
});
