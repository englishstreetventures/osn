/**
 * Property tests for the search string-math.
 *
 * `src/search.ts` states its invariants as facts in prose — `handlePrefixRange`
 * is "exactly equivalent" to `handle LIKE 'q%'`, `escapeLike` makes a typed
 * metacharacter "match itself", the `QUERY_SEPARATOR` exemption means `%`, `_`
 * and `\` "stay inside the token and reach `escapeLike`". `search.test.ts`
 * checks those claims against examples someone thought of; these check them
 * against exhaustive short strings from the relevant alphabets, plus boundary
 * cases. The functions under test are dependency-free string math, and the
 * test inputs need no property-testing package or Effect runtime.
 */

import { describe, expect, it } from "vitest";

import { escapeLike, handlePrefixRange, tokeniseQuery } from "../src/search";

/** Every short string over the supplied alphabet, including the empty string. */
function* stringsUpTo(alphabet: readonly string[], maxLength: number): Generator<string> {
  let values = [""];
  yield "";
  for (let length = 1; length <= maxLength; length++) {
    values = values.flatMap((prefix) => alphabet.map((char) => prefix + char));
    yield* values;
  }
}

const handleChars = [..."abcdefghijklmnopqrstuvwxyz0123456789_"];
const handleQueries = [...stringsUpTo(handleChars, 2), "a_b", "abc123", "zzzzzzzzzz", "0_"].filter(
  Boolean,
);

describe("handlePrefixRange — range membership is exactly prefix matching", () => {
  /**
   * Pairs of (query, handle) shaped so both answers get exercised.
   *
   * Two independently drawn handles almost never share a prefix, so a pair
   * generator that just crosses two arbitraries would test "not in range, does
   * not start with" ten thousand times and the interesting branch never. These
   * five shapes are the ones that decide the property:
   *
   * - `q` itself and `q + tail` — the range must contain them.
   * - an unrelated handle — it usually must not.
   * - `q` with its **last character replaced** — the near miss that pins the
   *   upper bound. The bound is `charCodeAt(last) + 1`, and the handle charset
   *   is not contiguous in code order (`9` is 0x39, `_` is 0x5F, `a` is 0x61),
   *   so this is where an off-by-one or a charset assumption would show.
   * - `q` with its last character dropped — a string `q` is a prefix *of*,
   *   which must fall below the lower bound.
   * - the upper bound itself, and the upper bound with a suffix. Without these
   *   two the property passes against an implementation that returns a
   *   *closed* `[lower, upper]` range, because no other shape here can land
   *   exactly on the bound (`tail` is never empty). They are the cases that
   *   make "half-open" mean something.
   */
  const successorOf = (value: string) =>
    value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) + 1);

  it("h is in the returned range iff h starts with q", () => {
    for (const query of handleQueries) {
      const range = handlePrefixRange(query);
      expect(range).not.toBeNull();
      if (range === null) continue;
      const upper = successorOf(query);
      for (const tail of ["a", "0", "_"]) {
        for (const handle of [
          query,
          query + tail,
          tail,
          query.slice(0, -1) + tail + "a",
          query.slice(0, -1),
          // The upper bound can be outside the handle alphabet, but still
          // determines whether the range is half-open.
          upper,
          upper + tail,
        ]) {
          const inRange = handle >= range.lower && handle < range.upper;
          expect(inRange, `query=${query}, handle=${handle}`).toBe(handle.startsWith(query));
        }
      }
    }
  });

  it("returns a range for exactly the queries that can prefix a handle", () => {
    const alphabet = ["a", "z", "0", "9", "_", "A", "%", "\\", " ", "é", "日"];
    for (const query of [...stringsUpTo(alphabet, 3), "@alice", "a-b", "a\nb"]) {
      const canPrefixAHandle = /^[a-z0-9_]+$/.test(query);
      expect(handlePrefixRange(query) !== null, `query=${query}`).toBe(canPrefixAHandle);
    }
  });
});

/**
 * Strings dense in LIKE metacharacters.
 *
 * Exhaustive short strings keep LIKE metacharacters in the test set.
 */
const metaHeavyInputs = [
  ...stringsUpTo(["a", "B", "1", "%", "_", "\\", " ", "-"], 3),
  "a%_\\ B-1",
  "é%日_\\",
  "a".repeat(40),
];

/** The inverse of `escapeLike`: drop the backslash from every escaped pair. */
const unescapeLike = (value: string) => value.replace(/\\([\s\S])/g, "$1");

describe("escapeLike — escaping is lossless and total", () => {
  it("round-trips: unescaping an escaped string returns the original", () => {
    for (const value of metaHeavyInputs) {
      expect(unescapeLike(escapeLike(value)), `value=${value}`).toBe(value);
    }
  });

  it("round-trips across scripts and control characters", () => {
    for (const value of ["日本語", "café", "👋🏽", "a\n%b", "\0_\\", "foo\r\nbar"]) {
      expect(unescapeLike(escapeLike(value))).toBe(value);
    }
  });

  it("leaves no unescaped metacharacter behind", () => {
    // The round trip alone would still pass if `escapeLike` escaped nothing at
    // all. This is the other half: strip every `\X` pair from the output and
    // what remains — the characters SQLite reads literally — must contain no
    // `%`, `_` or `\`, because each of those is what the escape exists to
    // neutralise.
    for (const value of metaHeavyInputs) {
      const literalRemainder = escapeLike(value).replace(/\\[\s\S]/g, "");
      expect(literalRemainder, `value=${value}`).not.toMatch(/[\\%_]/);
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
