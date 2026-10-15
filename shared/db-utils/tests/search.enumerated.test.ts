/**
 * Enumerated checks for the search string-math.
 *
 * `src/search.ts` states its invariants as facts in prose — `handlePrefixRange`
 * is "exactly equivalent" to `handle LIKE 'q%'`, `escapeLike` makes a typed
 * metacharacter "match itself", the `QUERY_SEPARATOR` exemption means `%`, `_`
 * and `\` "stay inside the token and reach `escapeLike`". `search.test.ts`
 * checks those claims against examples someone thought of; these check them
 * against every short string over each relevant alphabet, enumerated rather
 * than sampled, plus boundary cases. Every run checks the same inputs, so a
 * failure reproduces without a seed. The functions under test are
 * dependency-free string math, so this file needs no property-testing package
 * and no Effect runtime.
 */

import { describe, expect, it } from "vitest";

import { escapeLike, handlePrefixRange, tokeniseQuery } from "../src/search";

/** Every string over the supplied alphabet up to `maxLength`, including the empty string. */
function* stringsUpTo(alphabet: readonly string[], maxLength: number): Generator<string> {
  let values = [""];
  yield "";
  for (let length = 1; length <= maxLength; length++) {
    values = values.flatMap((prefix) => alphabet.map((char) => prefix + char));
    yield* values;
  }
}

/** The characters a handle may contain. The first test below holds it to the source. */
const handleChars = [..."abcdefghijklmnopqrstuvwxyz0123456789_"];
const isHandleChar = (char: string) => handleChars.includes(char);

describe("handlePrefixRange — range membership is exactly prefix matching", () => {
  it("accepts exactly the test's handle alphabet as single characters", () => {
    // Every UTF-16 code unit, surrogates included. If the charset in
    // src/search.ts changes, this fails before the range checks below can pass
    // over an alphabet the source no longer uses.
    const accepted: string[] = [];
    for (let unit = 0; unit <= 0xffff; unit++) {
      const char = String.fromCharCode(unit);
      if (handlePrefixRange(char) !== null) accepted.push(char);
    }
    expect(accepted.toSorted()).toEqual(handleChars.toSorted());
  });

  /**
   * Candidate handles shaped so both answers get exercised.
   *
   * Two unrelated handles almost never share a prefix, so pairing every query
   * with arbitrary handles would test "not in range, does not start with"
   * nearly every time. These shapes are the ones that decide the property:
   *
   * - `q` itself, and `q` plus a tail — the range must contain them. The tails
   *   are every handle character and a few longer strings.
   * - an unrelated handle: each single handle character.
   * - `q` with its **last character replaced** by each handle character, alone
   *   and with a suffix — the near misses that pin the upper bound. The bound
   *   is `charCodeAt(last) + 1`, and the handle charset is not contiguous in
   *   code order (`9` is 0x39, `_` is 0x5F, `a` is 0x61), so this is where an
   *   off-by-one or a charset assumption would show.
   * - `q` with its last character dropped — a string `q` is a prefix *of*,
   *   which must fall below the lower bound.
   * - the upper bound itself, and the upper bound with a suffix. A closed
   *   `[lower, upper]` range would contain the bound, so these make "half-open"
   *   mean something. A replaced-character near miss lands on the bound only
   *   when the next code point after `q`'s last character is itself a handle
   *   character; for `9`, `_` and `z` it is not, and only these two reach it.
   */
  const successorOf = (value: string) =>
    value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1);

  /** Every handle of one or two characters, plus longer ones. */
  const handleQueries = [
    ...stringsUpTo(handleChars, 2),
    "a_b",
    "abc123",
    "zzzzzzzzzz",
    "0_",
    "user_99z",
  ].filter(Boolean);
  const tails = [...handleChars, "a0_", "zz", "_9a"];

  it("h is in the returned range iff h starts with q", () => {
    const mismatches: string[] = [];
    let inside = 0;
    let outside = 0;
    for (const query of handleQueries) {
      const range = handlePrefixRange(query);
      if (range === null) {
        mismatches.push(`query=${query}: no range`);
        continue;
      }
      const stem = query.slice(0, -1);
      const upper = successorOf(query);
      const handles = [
        query,
        stem,
        upper,
        upper + "a",
        ...tails.map((tail) => query + tail),
        ...handleChars,
        ...handleChars.map((char) => stem + char),
        ...handleChars.map((char) => stem + char + "a"),
      ];
      for (const handle of handles) {
        const inRange = handle >= range.lower && handle < range.upper;
        if (inRange) inside++;
        else outside++;
        if (inRange !== handle.startsWith(query)) {
          mismatches.push(`query=${query}, handle=${handle}, inRange=${inRange}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Both answers must actually occur, or the check above proves nothing.
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  it("returns a range for exactly the queries that can prefix a handle", () => {
    const alphabet = ["a", "z", "0", "9", "_", "A", "%", "\\", " ", "é", "日"];
    for (const query of [...stringsUpTo(alphabet, 3), "@alice", "a-b", "a\nb"]) {
      const canPrefixAHandle = query.length > 0 && [...query].every(isHandleChar);
      expect(handlePrefixRange(query) !== null, `query=${query}`).toBe(canPrefixAHandle);
    }
  });
});

/**
 * Every string of up to three characters over an alphabet that is half LIKE
 * metacharacters, plus longer cases.
 */
const metaHeavyInputs = [
  ...stringsUpTo(["a", "B", "1", "%", "_", "\\", " ", "-"], 3),
  "a%_\\ B-1",
  "é%日_\\",
  "a".repeat(40),
];

/**
 * Other scripts, control characters, astral characters (surrogate pairs in
 * UTF-16) next to metacharacters, and lone surrogates. A JavaScript string can
 * hold a lone surrogate, and a malformed client can send one; escaping works on
 * code units, so it must neither split a pair nor drop an unpaired half.
 */
const unicodeInputs = [
  "日本語",
  "café",
  "👋🏽",
  "a\n%b",
  "\0_\\",
  "foo\r\nbar",
  "\u{1D11E}",
  "%\u{1F600}_",
  "\\\u{10FFFF}",
  "\uD800",
  "\uDFFF",
  "a\uD800%",
  "_\uDC00\\",
  "\uDC00\uD800",
];

/** The inverse of `escapeLike`: drop the backslash from every escaped pair. */
const unescapeLike = (value: string) => value.replace(/\\([\s\S])/g, "$1");

describe("escapeLike — escaping is lossless and total", () => {
  it("round-trips: unescaping an escaped string returns the original", () => {
    for (const value of metaHeavyInputs) {
      expect(unescapeLike(escapeLike(value)), `value=${value}`).toBe(value);
    }
  });

  it("round-trips across scripts, control characters, astral characters and lone surrogates", () => {
    for (const value of unicodeInputs) {
      expect(unescapeLike(escapeLike(value)), `value=${JSON.stringify(value)}`).toBe(value);
    }
  });

  it("leaves no unescaped metacharacter behind", () => {
    // The round trip alone would still pass if `escapeLike` escaped nothing at
    // all. This is the other half: strip every `\X` pair from the output and
    // what remains — the characters SQLite reads literally — must contain no
    // `%`, `_` or `\`, because each of those is what the escape exists to
    // neutralise.
    for (const value of [...metaHeavyInputs, ...unicodeInputs]) {
      const literalRemainder = escapeLike(value).replace(/\\[\s\S]/g, "");
      expect(literalRemainder, `value=${JSON.stringify(value)}`).not.toMatch(/[\\%_]/);
    }
  });
});

describe("tokeniseQuery — the LIKE metacharacters survive tokenisation", () => {
  /**
   * What a search box actually receives: letters in more than one script,
   * digits, the three metacharacters, and the punctuation and whitespace that
   * `QUERY_SEPARATOR` is meant to split on.
   */
  const queryInputs = [
    ...stringsUpTo(
      ["a", "B", "1", "%", "_", "\\", " ", "\t", ",", ".", "-", "@", "'", "/", "é", "日"],
      3,
    ),
    "Smith, John",
    "é% 日_\\foo",
  ];

  const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it("preserves every %, _ and \\ from the query in the tokens", () => {
    // This is the invariant `QUERY_SEPARATOR`'s doc comment rests on. If a
    // metacharacter were treated as a separator, `"a%b"` would tokenise to
    // `a` + `b` and the wildcard `escapeLike` was written to neutralise would
    // be silently gone — turning an exact-match pattern back into a wildcard
    // one, which is the failure mode nobody notices because it returns *more*
    // rows, not fewer.
    for (const query of queryInputs) {
      const joined = tokeniseQuery(query).join("");
      for (const meta of ["%", "_", "\\"] as const) {
        expect(countOf(joined, meta), `query=${query}, meta=${meta}`).toBe(countOf(query, meta));
      }
    }
  });

  it("only ever drops separator characters — tokens are a subsequence of the query", () => {
    for (const query of queryInputs) {
      // Every token must appear in the query, in order, without overlap.
      let cursor = 0;
      for (const token of tokeniseQuery(query)) {
        expect(token.length).toBeGreaterThan(0);
        const at = query.indexOf(token, cursor);
        expect(at, `query=${query}, token=${token}`).toBeGreaterThanOrEqual(0);
        cursor = at + token.length;
      }
    }
  });
});
