import { describe, expect, it } from "vitest";

import { profileInitials } from "../../src/lib/utils";

/**
 * The one rule every avatar's initials follow (people and organisations
 * alike): the first two characters of the name a reader sees, upper-cased. A
 * "character" is what a reader counts as one, so a joined emoji or a letter
 * with a combining mark is never cut in half. The seeded E2E names are plain
 * ASCII, so no flow sees these cases.
 */
describe("profileInitials", () => {
  it("takes the display name over the handle", () => {
    expect(profileInitials({ displayName: "ada lovelace", handle: "zed" })).toBe("AD");
  });

  it("falls back to the handle when the display name is blank", () => {
    expect(profileInitials({ displayName: "   ", handle: "zed" })).toBe("ZE");
    expect(profileInitials({ displayName: null, handle: "zed" })).toBe("ZE");
  });

  it("keeps a joined emoji and a combining mark whole", () => {
    // A family: four people joined by zero-width joiners, one character.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    expect(profileInitials({ displayName: `${family}x`, handle: "fam" })).toBe(`${family}X`);
    // "é" written as e and a combining acute accent.
    expect(profileInitials({ displayName: "émile", handle: "emile" })).toBe("ÉM");
  });

  it("draws a question mark for no one", () => {
    expect(profileInitials(null)).toBe("?");
  });
});
