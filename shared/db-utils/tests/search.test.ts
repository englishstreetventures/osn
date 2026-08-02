import { describe, it, expect } from "vitest";

import { escapeLike, handlePrefixRange, likeContains, normaliseHandleQuery } from "../src/search";

describe("normaliseHandleQuery", () => {
  it("strips a leading @ and lowercases", () => {
    expect(normaliseHandleQuery("@Alice")).toBe("alice");
    expect(normaliseHandleQuery("ALICE")).toBe("alice");
  });

  it("trims BEFORE stripping the sigil", () => {
    // The regression this shared version fixes: a copy that tested
    // `startsWith("@")` on the untrimmed string left the `@` in place for a
    // padded query, which then matched no handle at all. A leading space is
    // what a paste or a mobile keyboard's auto-space produces.
    expect(normaliseHandleQuery(" @alice")).toBe("alice");
    expect(normaliseHandleQuery("  @Alice  ")).toBe("alice");
  });

  it("folds repeated sigils", () => {
    expect(normaliseHandleQuery("@@alice")).toBe("alice");
  });

  it("only strips LEADING sigils", () => {
    expect(normaliseHandleQuery("al@ice")).toBe("al@ice");
  });

  it("returns an empty string for blank or sigil-only input", () => {
    expect(normaliseHandleQuery("")).toBe("");
    expect(normaliseHandleQuery("   ")).toBe("");
    expect(normaliseHandleQuery("@")).toBe("");
  });
});

describe("escapeLike", () => {
  it("escapes the wildcards and the escape char itself", () => {
    expect(escapeLike("b_ob")).toBe("b\\_ob");
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLike("alice")).toBe("alice");
  });
});

describe("likeContains", () => {
  it("wraps in wildcards while escaping the inner ones", () => {
    expect(likeContains("b_ob")).toBe("%b\\_ob%");
    expect(likeContains("alice")).toBe("%alice%");
  });
});

/** The half-open comparison the SQL `handle >= lower AND handle < upper` makes. */
function inRange(handle: string, range: { lower: string; upper: string }): boolean {
  return handle >= range.lower && handle < range.upper;
}

describe("handlePrefixRange", () => {
  it("returns a half-open range whose upper bound is the successor", () => {
    expect(handlePrefixRange("ab")).toEqual({ lower: "ab", upper: "ac" });
    expect(handlePrefixRange("a")).toEqual({ lower: "a", upper: "b" });
  });

  it("increments only the LAST character", () => {
    const range = handlePrefixRange("az")!;
    expect(range).toEqual({ lower: "az", upper: "a{" });
    // 'z' (0x7A) → '{' (0x7B), which sorts above every handle character, so
    // "az…" rows fall inside the range and "b…" rows do not.
    expect(inRange("azzz", range)).toBe(true);
    expect(inRange("b", range)).toBe(false);
  });

  it("treats an underscore as a literal, not a wildcard", () => {
    const range = handlePrefixRange("b_o")!;
    expect(inRange("b_ob", range)).toBe(true);
    // The bug a LIKE without ESCAPE would have: `b_o%` matching "brob".
    expect(inRange("brob", range)).toBe(false);
  });

  it("handles digits and underscores at the boundary", () => {
    expect(handlePrefixRange("a_")).toEqual({ lower: "a_", upper: "a`" });
    expect(handlePrefixRange("a9")).toEqual({ lower: "a9", upper: "a:" });
  });

  it("returns null for a query that cannot prefix any handle", () => {
    // Handles are `^[a-z0-9_]+$`, so none of these can match anything — the
    // caller skips the pass instead of scanning for zero rows.
    expect(handlePrefixRange("")).toBeNull();
    expect(handlePrefixRange("Alice")).toBeNull(); // not lowercased yet
    expect(handlePrefixRange("al ice")).toBeNull();
    expect(handlePrefixRange("al%")).toBeNull();
    expect(handlePrefixRange("ali.ce")).toBeNull();
    expect(handlePrefixRange("émile")).toBeNull();
  });

  it("composes with normaliseHandleQuery", () => {
    expect(handlePrefixRange(normaliseHandleQuery(" @Alice "))).toEqual({
      lower: "alice",
      upper: "alicf",
    });
  });
});
