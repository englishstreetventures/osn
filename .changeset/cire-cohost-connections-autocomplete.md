---
"@osn/api": patch
"@shared/db-utils": minor
---

Share the search primitives, and make internal handle search an index seek.

- `@shared/db-utils`: new `@shared/db-utils/search` module (also re-exported
  from the barrel) holding `normaliseHandleQuery`, `escapeLike`, `likeContains`
  and `handlePrefixRange`. These were three private near-copies across
  `recommendations.ts`, `graph-internal.ts` and cire's `directory.ts`, and the
  copies had drifted: only one knew that `handle LIKE 'q%'` does not use the
  index, and the normalisers disagreed on trim-versus-strip order. Dependency-free
  string math, so the subpath is reachable without the drizzle/effect graph.
- `@osn/api`: `GET /graph/internal/profile-search` now matches on the half-open
  BINARY range instead of `LIKE 'q%'` — `EXPLAIN QUERY PLAN` goes from
  `SCAN users USING INDEX users_handle_idx` to
  `SEARCH … (handle>? AND handle<?)`. Closes backlog item P-I
  (`internal-profile-search-scan`). The range makes `_` literal for free, so the
  LIKE escaping on that path is gone rather than merely correct, and a query
  containing a character no handle can hold now skips the read entirely.
- `@osn/api`: fixes a normalisation bug the shared version absorbed — the local
  normaliser tested `startsWith("@")` *before* trimming, so `" @alice"` (a paste,
  or a mobile keyboard's auto-space) kept its sigil and resolved to nothing on
  `/profile-by-handle` and `/profile-search`.
- `@osn/api`: new `GET /graph/internal/connection-search` — ARC `graph:read`,
  returns one profile's own **accepted** connections (handle-prefix range OR
  display-name substring, tombstoned accounts excluded, ordered by handle, capped
  at 10). Backs cire's connection-aware co-host autocomplete. Unlike
  `/profile-search` it has no minimum query length and treats an empty query as
  "first page of connections", because the result set is bounded by one profile's
  graph — a list that profile can already read via the user-facing
  `GET /graph/connections` — rather than by the handle namespace.
