import { describe, it, expect } from "vitest";

// The barrel re-exports the same helpers for consumers that already pull the
// drizzle/effect graph. Imported here under an alias so a dropped or misspelt
// re-export fails a test rather than only failing whoever tries it next.
import * as barrel from "../src";
import {
  escapeLike,
  handlePrefixRange,
  joinTokens,
  likeContains,
  normaliseHandleQuery,
  hasScanworthyToken,
  tokenContentLength,
  tokeniseQuery,
  tokensPrefixName,
} from "../src/search";

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

describe("tokeniseQuery", () => {
  it("splits on whitespace and punctuation", () => {
    expect(tokeniseQuery("john smith")).toEqual(["john", "smith"]);
    expect(tokeniseQuery("  john   smith  ")).toEqual(["john", "smith"]);
    expect(tokeniseQuery("smith-jones")).toEqual(["smith", "jones"]);
    expect(tokeniseQuery("o'brien")).toEqual(["o", "brien"]);
    expect(tokeniseQuery("acme inc.")).toEqual(["acme", "inc"]);
  });

  it("keeps every LIKE metacharacter, because escapeLike must still see them", () => {
    // A separator swallows the character before `escapeLike` can neutralise it,
    // which turns the one wildcard the escape exists to defuse back into a
    // wildcard: `"a%b"` splitting to `a` + `b` matches any row with both
    // letters. `%`, `_` and `\` therefore stay inside the token.
    expect(tokeniseQuery("a%b")).toEqual(["a%b"]);
    expect(tokeniseQuery("a\\b")).toEqual(["a\\b"]);
    expect(likeContains(tokeniseQuery("a%b")[0]!)).toBe("%a\\%b%");
  });

  it("splits on ordinary punctuation, which is not a metacharacter", () => {
    // Safe to drop: it cannot widen a pattern into a wildcard. It does shorten
    // the token, which is why gates read `tokenContentLength`, not the query.
    expect(tokeniseQuery("smith, john")).toEqual(["smith", "john"]);
    expect(tokeniseQuery("a.b")).toEqual(["a", "b"]);
  });

  it("keeps underscores, because handles contain them", () => {
    // Splitting here would turn a typed `@jo_smith` into `jo` + `smith`, which
    // then matches `@joxsmith` just as well — quietly undoing the literal-`_`
    // matching `escapeLike` exists to provide.
    expect(tokeniseQuery("jo_smith")).toEqual(["jo_smith"]);
  });

  it("is unicode-aware", () => {
    expect(tokeniseQuery("zoë müller")).toEqual(["zoë", "müller"]);
    expect(tokeniseQuery("日本 太郎")).toEqual(["日本", "太郎"]);
  });

  it("returns [] for a query with no word characters", () => {
    expect(tokeniseQuery("")).toEqual([]);
    expect(tokeniseQuery("   ")).toEqual([]);
    expect(tokeniseQuery("!!!")).toEqual([]);
  });
});

describe("tokenContentLength", () => {
  it("counts what was typed, not what was typed into", () => {
    // The measurement every length gate keys on. A gate reading the raw string
    // is walked past by typing a separator: `"a b"` is three characters of
    // string carrying two of signal, and `"a."` two carrying one.
    expect(tokenContentLength(tokeniseQuery("a b"))).toBe(2);
    expect(tokenContentLength(tokeniseQuery("a."))).toBe(1);
    expect(tokenContentLength(tokeniseQuery("john smith"))).toBe(9);
    expect(tokenContentLength([])).toBe(0);
  });
});

describe("hasScanworthyToken", () => {
  it("passes a query carrying one real term, even beside short ones", () => {
    // An AND of LIKE patterns is only as selective as its most selective
    // conjunct, so the gate asks whether ANY token is worth scanning for.
    expect(hasScanworthyToken(tokeniseQuery("j smith"), 3)).toBe(true);
    expect(hasScanworthyToken(tokeniseQuery("smith"), 3)).toBe(true);
  });

  it("blocks a query that is only short tokens", () => {
    expect(hasScanworthyToken(tokeniseQuery("a b c"), 3)).toBe(false);
    expect(hasScanworthyToken(tokeniseQuery("a a"), 3)).toBe(false);
    expect(hasScanworthyToken(tokeniseQuery("ab"), 3)).toBe(false);
    expect(hasScanworthyToken([], 3)).toBe(false);
  });

  it("clears dense scripts at two characters", () => {
    // The Latin threshold is a proxy for selectivity, and a bad one across
    // scripts. "日本 太郎" is a complete name whose every token is two
    // characters; a flat three-character rule makes it unsearchable.
    expect(hasScanworthyToken(tokeniseQuery("日本 太郎"), 3)).toBe(true);
    expect(hasScanworthyToken(tokeniseQuery("太郎"), 3)).toBe(true);
    expect(hasScanworthyToken(tokeniseQuery("김민"), 3)).toBe(true);
    expect(hasScanworthyToken(tokeniseQuery("たろ"), 3)).toBe(true);
    // One character is still one character in any script.
    expect(hasScanworthyToken(tokeniseQuery("本"), 3)).toBe(false);
  });

  it("does not lower the bar for accented Latin", () => {
    // Diacritics are not a dense script — "mü" narrows about as much as "mu".
    expect(hasScanworthyToken(tokeniseQuery("mü"), 3)).toBe(false);
    expect(hasScanworthyToken(tokeniseQuery("müller"), 3)).toBe(true);
  });
});

describe("joinTokens", () => {
  it("spells the handle a multi-word query is reaching for", () => {
    expect(joinTokens(["john", "smith"])).toBe("johnsmith");
    expect(joinTokens(["alice"])).toBe("alice");
    expect(joinTokens([])).toBe("");
  });

  it("composes into a prefix range a spaced query could not produce alone", () => {
    // A space can't prefix a handle, so `handlePrefixRange("john smith")` is
    // null — the seek is skipped entirely without the rejoin.
    expect(handlePrefixRange("john smith")).toBeNull();
    expect(handlePrefixRange(joinTokens(tokeniseQuery("john smith")))).toEqual({
      lower: "johnsmith",
      upper: "johnsmiti",
    });
  });
});

describe("tokensPrefixName", () => {
  it("matches a token that is not the first", () => {
    // The whole point: surnames are not prefixes of full names.
    expect(tokensPrefixName("Roberta Smith", ["smith"])).toBe(true);
    expect(tokensPrefixName("Roberta Smith", ["rob"])).toBe(true);
    expect(tokensPrefixName("Roberta Smith", ["rob", "smi"])).toBe(true);
    expect(tokensPrefixName("Roberta Smith", ["smi", "rob"])).toBe(true);
  });

  it("requires a prefix, not a substring", () => {
    // What separates this tier from the name-infix tier below it.
    expect(tokensPrefixName("Blacksmith Ltd", ["smith"])).toBe(false);
    expect(tokensPrefixName("Blacksmith Ltd", ["black"])).toBe(true);
  });

  it("requires every query token to land", () => {
    expect(tokensPrefixName("Roberta Smith", ["rob", "zed"])).toBe(false);
  });

  it("is case-insensitive and splits the name like the query", () => {
    expect(tokensPrefixName("ROBERTA SMITH-JONES", ["jones"])).toBe(true);
    expect(tokensPrefixName("O'Brien", ["brien"])).toBe(true);
  });

  it("matches a duplicated token against the same word", () => {
    // Documented looseness: tokens match independently and may share a target
    // word, so a typo-repeat still matches rather than mysteriously failing.
    expect(tokensPrefixName("Jo", ["jo", "jo"])).toBe(true);
  });

  it("splits punctuation on both sides, not just the name", () => {
    // Splitting only the name would leave a query token carrying punctuation
    // unmatchable against either half of the name it came from.
    expect(tokensPrefixName("Smith-Jones", ["smith-jones"])).toBe(true);
    expect(tokensPrefixName("O'Brien", ["o'bri"])).toBe(true);
  });

  it("is false for an absent name or an empty token list", () => {
    expect(tokensPrefixName(null, ["rob"])).toBe(false);
    expect(tokensPrefixName(undefined, ["rob"])).toBe(false);
    expect(tokensPrefixName("Roberta Smith", [])).toBe(false);
    expect(tokensPrefixName("!!!", ["rob"])).toBe(false);
  });
});

describe("barrel re-exports", () => {
  it("exposes the same search helpers as the subpath entry", () => {
    expect(barrel.normaliseHandleQuery).toBe(normaliseHandleQuery);
    expect(barrel.escapeLike).toBe(escapeLike);
    expect(barrel.likeContains).toBe(likeContains);
    expect(barrel.handlePrefixRange).toBe(handlePrefixRange);
    expect(barrel.tokeniseQuery).toBe(tokeniseQuery);
    expect(barrel.joinTokens).toBe(joinTokens);
    expect(barrel.tokenContentLength).toBe(tokenContentLength);
    expect(barrel.hasScanworthyToken).toBe(hasScanworthyToken);
    expect(barrel.tokensPrefixName).toBe(tokensPrefixName);
  });
});
