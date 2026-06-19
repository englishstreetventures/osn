---
"@cire/api": patch
"@cire/organiser": patch
---

Co-host add: autocomplete OSN handles as the organiser types.

- `@cire/api`: new `OsnHandleSearchResolver` ARC bridge
  (`createArcHandleSearchResolver` / `createHandleSearchResolverFromEnv`,
  `graph:read`, key-optional + FAIL-SOFT → empty list on any failure), wired
  through `createApp`/`AppOptions`/`index.ts` like the #177 display resolver.
  New `GET /api/organiser/handle-search?q=` route, gated by `osnAuth()` only
  (any signed-in organiser; NOT wedding-scoped), with a light per-IP rate limit
  (60/min). Returns `{ profiles: [...] }`; empty on a missing/short query or an
  unavailable ARC bridge — the manual type-and-submit add path is unaffected.
- `@cire/organiser`: the add-co-host input in `HostsPanel` is now an accessible
  combobox — debounced (~280ms) handle search, a keyboard-navigable suggestion
  dropdown (`@handle — displayName`, arrow keys + Enter + Escape,
  `aria-activedescendant`), and pick-to-fill. Fails soft (no dropdown) when the
  search is unavailable; manual typing still works.
