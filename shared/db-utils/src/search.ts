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
