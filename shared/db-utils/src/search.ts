/**
 * Primitives shared by every handle/name search in the monorepo — osn-api's
 * people+organisation search and its internal `/graph/internal/profile-search`
 * and `/connection-search` endpoints, and cire-api's vendor directory browse.
 *
 * These were three near-identical private copies before, and the copies had
 * drifted: `escapeLike` was byte-identical in all three, but the query
 * normalisers disagreed on whether to trim before or after stripping the `@`
 * sigil (a difference that silently broke `" @alice"` — see
 * {@link normaliseHandleQuery}), and only one of the three knew that a
 * `LIKE 'q%'` prefix match does not use the index (see
 * {@link handlePrefixRange}). Sharing them is what keeps that knowledge from
 * having to be rediscovered per call site.
 *
 * Deliberately dependency-free string math: no drizzle, no effect, no DB
 * handle. The caller builds the SQL; this decides what to match on. That is
 * also why it is reachable as `@shared/db-utils/search` as well as through the
 * barrel — a consumer that only needs the string helpers shouldn't pull the
 * drizzle/effect graph behind them.
 */

/** The character set every OSN handle (user and organisation) is constrained to. */
const HANDLE_CHARS = /^[a-z0-9_]+$/;

/**
 * Query token separator: anything that is not a letter, a digit, or a `LIKE`
 * metacharacter.
 *
 * The metacharacter exemption is the whole subtlety. A query token becomes a
 * `LIKE` pattern, and {@link escapeLike} exists to make a typed `%`, `_` or `\`
 * match itself — but it can only escape characters that survive tokenisation.
 * Treating them as separators turns `"a%b"` into `a` + `b`, which matches any
 * row containing both letters, silently converting the one wildcard the escape
 * was written to neutralise back into a wildcard. So `%`, `_` and `\` stay
 * inside the token and reach `escapeLike`.
 *
 * Ordinary punctuation splits, because it is not a metacharacter: dropping it
 * cannot widen a pattern into a wildcard, and `"Smith, John"` has to tokenise
 * the way a person reading it would. It does still make the token shorter than
 * the string it came from — which is exactly why every length gate must be
 * computed from the tokens (see {@link tokenContentLength}) and never from the
 * raw query.
 */
const QUERY_SEPARATOR = /[^\p{L}\p{N}_%\\]+/u;

/**
 * Word separator for comparing a query against a display name — anything that
 * is not a letter, a digit or an underscore. Applied to *both* sides in
 * {@link tokensPrefixName}, so `"Smith-Jones"`, `"O'Brien"` and `"Acme  Inc."`
 * all break the way a person reading them would. Unicode-aware (`\p{L}`),
 * because display names are not ASCII.
 *
 * Underscore is excluded from the separator set because it is a legal handle
 * character (`^[a-z0-9_]+$`), so `jo_smith` reads as one word here just as it
 * does in a handle.
 */
const WORD_SEPARATOR = /[^\p{L}\p{N}_]+/u;

/**
 * Normalises a user-typed query the way handle storage expects: trims, strips
 * any leading `@` sigils, then lowercases. `users.handle` is stored lowercase
 * and constrained to `^[a-z0-9_]+$`, so this is what makes `@Alice`, `alice`
 * and `  @alice ` the same search.
 *
 * The trim comes FIRST, which is the fix this shared version carries. The
 * previous `graph-internal.ts` copy tested `raw.startsWith("@")` before
 * trimming, so a query with a leading space — `" @alice"`, exactly what a
 * paste or a mobile keyboard's auto-space produces — failed the test, kept its
 * `@`, and then matched no handle at all. Stripping `@+` rather than a single
 * `@` folds `"@@alice"` too.
 */
export function normaliseHandleQuery(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Escapes the LIKE wildcards (`%`, `_`) plus the escape character itself, so a
 * user-typed `_` matches literally — handles may contain underscores, and an
 * unescaped one silently widens the match to any single character.
 *
 * Pair with an explicit `ESCAPE '\'` clause at the call site; `escapeLike`
 * alone does nothing without it.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A `%value%` LIKE pattern with the wildcards inside `value` escaped — the
 * substring-match half of a search, used where a prefix range can't apply
 * (display names, vendor names, descriptions, locations).
 */
export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}

/**
 * Half-open `[lower, upper)` range matching every handle starting with `query`,
 * or `null` when `query` cannot prefix any handle.
 *
 * This exists instead of `handle LIKE 'q%'` because **that does not use the
 * index**. SQLite's LIKE-prefix optimisation requires the indexed column's
 * collation to match LIKE's case sensitivity; `case_sensitive_like` is off by
 * default (D1 runs stock defaults) and the handle indexes are BINARY, so the
 * planner degrades to `SCAN … USING INDEX` — a full traversal — rather than a
 * seek. An explicit BINARY range gets `SEARCH … (handle>? AND handle<?)`:
 *
 * ```
 * handle LIKE 'ab%' ESCAPE '\'      ->  SCAN users USING INDEX users_handle_idx
 * handle >= 'ab' AND handle < 'ac'  ->  SEARCH users USING INDEX users_handle_idx
 * ```
 *
 * The two are exactly equivalent for handles: they are stored lowercase and
 * constrained to `^[a-z0-9_]+$`, and {@link normaliseHandleQuery} lowercases
 * the query, so there is no case for the case-insensitive comparison to differ
 * on. A query containing anything outside that set can't prefix a handle at
 * all, hence the `null` — the caller skips the pass instead of scanning for
 * zero rows. An empty query also returns `null`: it would otherwise describe
 * "every handle", which is a table scan wearing a range's clothes.
 */
export function handlePrefixRange(query: string): { lower: string; upper: string } | null {
  if (!HANDLE_CHARS.test(query)) return null;
  // Every handle char is single-code-unit ASCII, and the highest ('z', 0x7A)
  // increments to '{' (0x7B), so the successor is always a valid bound.
  const lastIndex = query.length - 1;
  const upper = query.slice(0, lastIndex) + String.fromCharCode(query.charCodeAt(lastIndex) + 1);
  return { lower: query, upper };
}

/**
 * Splits a normalised query into its word tokens, dropping empties.
 *
 * A search box takes what a person types, and people type names the way they
 * say them — `"john smith"`, not `"johnsmith"`. Without tokens the whole query
 * is one opaque string, so `"john smith"` can only ever match a display name
 * that contains that exact substring in that exact order: `"Smith, John"` and
 * `"John A. Smith"` both miss, and `@johnsmith` — the handle the person is
 * almost certainly reaching for — misses too because the space can't prefix a
 * handle. Tokens are what let the caller ask the two questions worth asking:
 * does every token appear (order-free matching), and does every token *start* a
 * name token (the prefix match a typeahead is really doing).
 *
 * Tokens split on whitespace and ordinary punctuation, but keep any `LIKE`
 * metacharacter — see {@link QUERY_SEPARATOR} for why that exemption matters.
 *
 * @see {@link joinTokens} for the handle-shaped rejoin of the same tokens.
 */
export function tokeniseQuery(query: string): string[] {
  return query.split(QUERY_SEPARATOR).filter((token) => token.length > 0);
}

/**
 * Scripts where a character carries far more signal than a Latin letter does.
 *
 * A minimum-length gate is really a minimum-*selectivity* gate, and character
 * count is only a proxy for selectivity. It is a decent proxy within an
 * alphabet of 26 and a bad one across scripts: two Han characters pick a name
 * out of a very large space, where two Latin letters barely narrow anything.
 * Applying one threshold to both is what makes a Latin-shaped rule quietly
 * exclude entire writing systems — `"日本 太郎"` is a complete name whose every
 * token is two characters long.
 */
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Whether any token is selective enough to justify an unanchored scan.
 *
 * `minimum` is the Latin threshold; tokens in a {@link DENSE_SCRIPT} clear the
 * gate at two characters instead, because two characters there is already a
 * specific query. Testing *some* token rather than the total is deliberate: an
 * `AND` of `LIKE` patterns is only as selective as its most selective conjunct,
 * so `"a b c"` is three near-matchless scans while `"j smith"` carries one
 * genuine term and should run.
 */
export function hasScanworthyToken(tokens: string[], minimum: number): boolean {
  return tokens.some(
    (token) => token.length >= (DENSE_SCRIPT.test(token) ? Math.min(2, minimum) : minimum),
  );
}

/**
 * Total length of the query's token content — the query with its whitespace
 * removed.
 *
 * This, not the raw string length, is what a minimum-length gate should compare
 * against. `"a b"` is a three-character string carrying two characters of
 * signal, and a gate that cannot tell the difference can be walked straight
 * past by typing a space.
 */
export function tokenContentLength(tokens: string[]): number {
  return tokens.reduce((total, token) => total + token.length, 0);
}

/**
 * Rejoins tokens into the handle they would spell — `["john", "smith"]` becomes
 * `"johnsmith"`. Handles have no separators, so this is the form a multi-word
 * query has to take before it can seek a handle prefix range at all.
 *
 * For a single-token query this is the identity, which is what keeps the
 * one-word path (the overwhelming majority of typeahead traffic) unchanged.
 */
export function joinTokens(tokens: string[]): string {
  return tokens.join("");
}

/**
 * True when every token of `query` prefixes some token of `text`.
 *
 * This is the match a name-based typeahead is actually performing: typing
 * `"smith"` should find `"Roberta Smith"`, and typing `"rob smi"` should find
 * her too. A plain substring test can't express either — it ranks
 * `"Roberta Smith"` for `"smith"` no higher than `"Blacksmith Ltd"`, and finds
 * nothing at all for `"smi rob"`.
 *
 * Tokens are matched independently and may share a target token, so
 * `"jo jo"` still matches `"Jo"`. That looseness is deliberate: this decides
 * *ranking*, not visibility, and a duplicated token is a typo, not an attack.
 */
export function tokensPrefixName(text: string | null | undefined, tokens: string[]): boolean {
  if (!text || tokens.length === 0) return false;
  const splitWords = (value: string) =>
    value
      .toLowerCase()
      .split(WORD_SEPARATOR)
      .filter((word) => word.length > 0);
  const nameWords = splitWords(text);
  if (nameWords.length === 0) return false;
  // Both sides split on the same word separator, so a query token carrying
  // punctuation (`"smith-jones"`) is compared word-for-word against a name
  // carrying the same (`"Smith-Jones"`). Splitting only the name would leave
  // the query token unmatchable against either half.
  const queryWords = tokens.flatMap(splitWords);
  if (queryWords.length === 0) return false;
  return queryWords.every((word) => nameWords.some((nameWord) => nameWord.startsWith(word)));
}
