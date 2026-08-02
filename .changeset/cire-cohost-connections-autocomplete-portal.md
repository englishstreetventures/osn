---
"@cire/api": patch
"@cire/organiser": patch
---

Co-host add: autocomplete from the organiser's OSN connections.

- `@cire/api`: new `OsnConnectionSearchResolver` ARC bridge
  (`createArcConnectionSearchResolver` / `createConnectionSearchResolverFromEnv`,
  `graph:read`, key-optional + FAIL-SOFT), wired through
  `createApp`/`AppOptions`/`index.ts` like its sibling resolvers.
  `GET /api/organiser/handle-search?q=` now merges two sources — the caller's own
  connections first (flagged `connected: true`), the global handle prefix search
  second — deduped, with the caller filtered out, capped at 8. The viewer id is
  the caller's own token `sub`, so an organiser can only search their own graph.
  An empty query is now meaningful: it returns the organiser's connections
  (nothing from the global search), which is what backs the portal's on-focus
  dropdown. Each source is caught independently, so one failing lookup degrades
  only itself instead of emptying the list.
- `@cire/api`: `directory.ts` drops its private `escapeLike` for the shared
  `likeContains` from `@shared/db-utils/search` — same behaviour, one fewer copy
  of the LIKE-escaping rule to keep in sync.
- `@cire/organiser`: `HostsPanel` opens its suggestion dropdown on focus with a
  "From your OSN connections" caption (fetched once per cycle), badges
  connections in a mixed result list, and drops its client-side 2-character
  floor — connections match from the first character. Manual type-and-submit is
  unchanged, and a search outage still just means no dropdown.
