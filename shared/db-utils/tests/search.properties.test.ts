/**
 * Property tests for the search string-math.
 *
 * `src/search.ts` states its invariants as facts in prose — `handlePrefixRange`
 * is "exactly equivalent" to `handle LIKE 'q%'`, `escapeLike` makes a typed
 * metacharacter "match itself", the `QUERY_SEPARATOR` exemption means `%`, `_`
 * and `\` "stay inside the token and reach `escapeLike`". `search.test.ts`
 * checks those claims against examples someone thought of; these check them
 * against generated input, which is the only way a claim with the word
 * *exactly* in it can be held to its word.
 *
 * Written with bare `FastCheck` from `effect/testing` rather than
 * `@effect/vitest`'s `it.prop`, because `@shared/db-utils` does not depend on
 * `@effect/vitest` and none of this needs an Effect runtime — the functions
 * under test are deliberately dependency-free string math.
 *
 * The domains are pinned tightly on purpose. An over-broad arbitrary is worse
 * than no test: it either fails on input the function never promised to handle,
 * or it wanders so far from the real input space that the interesting branch is
 * never reached. Every generator below either derives from the handle charset
 * the source constrains itself to, or draws from an explicit alphabet chosen so
 * the LIKE metacharacters actually show up.
 */

import { Schema } from "effect";
import { FastCheck } from "effect/testing";
import { describe, expect, it } from "vitest";

import { escapeLike, handlePrefixRange, tokeniseQuery } from "../src/search";

/** More runs than fast-check's default 100 — these are microseconds each. */
const RUNS = { numRuns: 1000 } as const;

/**
 * The handle charset, as the source constrains it: `^[a-z0-9_]+$`.
 *
 * Derived through `Schema.toArbitrary` from the same pattern rather than
 * hand-built from `fc.constantFrom`, so the generator is a restatement of the
 * constraint instead of a second copy of it that can drift from it.
 */
const HandleLike = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,10}$/));
const handleArb = Schema.toArbitrary(HandleLike)(FastCheck);

/** A single handle character, for building near-miss siblings of a query. */
const handleCharArb = FastCheck.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split(""));

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

  const pairArb = FastCheck.tuple(handleArb, handleArb, handleCharArb).chain(([q, tail, c]) =>
    FastCheck.constantFrom(
      q,
      q + tail,
      tail,
      q.slice(0, -1) + c + tail,
      q.slice(0, -1),
      // Not always a legal handle — `"z"` succeeds to `"{"` — but the property
      // is about string ordering, and `startsWith` answers for any string.
      successorOf(q),
      successorOf(q) + tail,
    ).map((h) => [q, h] as const),
  );

  it("h is in the returned range iff h starts with q", () => {
    FastCheck.assert(
      FastCheck.property(pairArb, ([query, handle]) => {
        const range = handlePrefixRange(query);
        // Every query here is drawn from the handle charset, so a range is
        // always returned; a null would itself be the bug.
        expect(range).not.toBeNull();
        if (range === null) return;
        const inRange = handle >= range.lower && handle < range.upper;
        // `startsWith` is the honest oracle for `handle LIKE 'q%'` here:
        // handles are stored lowercase and `normaliseHandleQuery` lowercases
        // the query, so SQLite's case-insensitive LIKE has no case to differ
        // on, and there are no wildcards left in a charset-constrained query.
        expect(inRange).toBe(handle.startsWith(query));
      }),
      RUNS,
    );
  });

  it("returns a range for exactly the queries that can prefix a handle", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.string({ maxLength: 12 }), (query) => {
        const canPrefixAHandle = /^[a-z0-9_]+$/.test(query);
        expect(handlePrefixRange(query) !== null).toBe(canPrefixAHandle);
      }),
      RUNS,
    );
  });
});

/**
 * Strings dense in LIKE metacharacters.
 *
 * `fc.string()` over the full unicode range produces a `%` about never, so the
 * escape properties would pass without ever escaping anything. This alphabet
 * makes the metacharacters roughly a third of every generated string.
 */
const metaHeavyArb = FastCheck.string({
  unit: FastCheck.constantFrom("a", "B", "1", "%", "_", "\\", " ", "-"),
  maxLength: 24,
});

/** The inverse of `escapeLike`: drop the backslash from every escaped pair. */
const unescapeLike = (value: string) => value.replace(/\\([\s\S])/g, "$1");

describe("escapeLike — escaping is lossless and total", () => {
  it("round-trips: unescaping an escaped string returns the original", () => {
    FastCheck.assert(
      FastCheck.property(metaHeavyArb, (value) => {
        expect(unescapeLike(escapeLike(value))).toBe(value);
      }),
      RUNS,
    );
  });

  it("round-trips over arbitrary text too, not just the metacharacter alphabet", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.string({ maxLength: 40 }), (value) => {
        expect(unescapeLike(escapeLike(value))).toBe(value);
      }),
      RUNS,
    );
  });

  it("leaves no unescaped metacharacter behind", () => {
    // The round trip alone would still pass if `escapeLike` escaped nothing at
    // all. This is the other half: strip every `\X` pair from the output and
    // what remains — the characters SQLite reads literally — must contain no
    // `%`, `_` or `\`, because each of those is what the escape exists to
    // neutralise.
    FastCheck.assert(
      FastCheck.property(metaHeavyArb, (value) => {
        const literalRemainder = escapeLike(value).replace(/\\[\s\S]/g, "");
        expect(literalRemainder).not.toMatch(/[\\%_]/);
      }),
      RUNS,
    );
  });
});

describe("tokeniseQuery — the LIKE metacharacters survive tokenisation", () => {
  /**
   * What a search box actually receives: letters in more than one script,
   * digits, the three metacharacters, and the punctuation and whitespace that
   * `QUERY_SEPARATOR` is meant to split on.
   */
  const queryArb = FastCheck.string({
    unit: FastCheck.constantFrom(
      "a",
      "B",
      "1",
      "%",
      "_",
      "\\",
      " ",
      "\t",
      ",",
      ".",
      "-",
      "@",
      "'",
      "/",
      "é",
      "日",
    ),
    maxLength: 24,
  });

  const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it("preserves every %, _ and \\ from the query in the tokens", () => {
    // This is the invariant `QUERY_SEPARATOR`'s doc comment rests on. If a
    // metacharacter were treated as a separator, `"a%b"` would tokenise to
    // `a` + `b` and the wildcard `escapeLike` was written to neutralise would
    // be silently gone — turning an exact-match pattern back into a wildcard
    // one, which is the failure mode nobody notices because it returns *more*
    // rows, not fewer.
    FastCheck.assert(
      FastCheck.property(queryArb, (query) => {
        const joined = tokeniseQuery(query).join("");
        for (const meta of ["%", "_", "\\"] as const) {
          expect(countOf(joined, meta)).toBe(countOf(query, meta));
        }
      }),
      RUNS,
    );
  });

  it("only ever drops separator characters — tokens are a subsequence of the query", () => {
    FastCheck.assert(
      FastCheck.property(queryArb, (query) => {
        // Every token must appear in the query, in order, without overlap.
        let cursor = 0;
        for (const token of tokeniseQuery(query)) {
          expect(token.length).toBeGreaterThan(0);
          const at = query.indexOf(token, cursor);
          expect(at).toBeGreaterThanOrEqual(0);
          cursor = at + token.length;
        }
      }),
      RUNS,
    );
  });
});
