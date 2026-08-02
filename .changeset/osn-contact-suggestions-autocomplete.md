---
"@osn/api": minor
"@osn/client": minor
"@osn/social": minor
---

Contact suggestions and a shell search bar in OSN Social. Search is reachable
from anywhere — a live combobox in the desktop rail and a `/search` page behind
a new Search tab in the mobile bottom bar — and Discover's suggestion cards now
say why each person is being suggested.

- `@osn/api`: new `GET /recommendations/search?q=&limit=&orgLimit=` —
  autocomplete over people **and** organisations, both sections in one round
  trip. One endpoint rather than two because this is typeahead: one request per
  keystroke means one abort to cancel, one rate-limit budget to reason about,
  and no torn state where the people half of a result set is newer than the
  organisation half. People match on handle and display name, two-phase by
  design: pass 1 is an index **seek** over a half-open handle range, and the
  unanchored `%q%` pass over handle + display name runs only when that
  under-fills the page *and* the query is at least three characters. The range
  is deliberate — `handle LIKE 'q%'` does **not** use the index, because
  SQLite's LIKE-prefix optimisation needs a collation matching LIKE's case
  sensitivity and both handle indexes are BINARY with `case_sensitive_like`
  off, so it plans as `SCAN … USING INDEX`. The two forms are exactly
  equivalent here (handles are lowercase and `^[a-z0-9_]+$`), so this is a pure
  planner win. Queries are normalised (trim, strip `@`, lowercase) and
  LIKE-escaped so an underscore in a handle matches literally; anything under
  two characters returns an empty list rather than a 4xx. Self, tombstoned
  accounts and profiles blocked in either direction are excluded. Each result
  carries the caller's own connection state (`none` / `pending_sent` /
  `pending_received` / `connected`), batched in one query for the whole page —
  the same fact `GET /graph/connections/:handle` already reports per handle, so
  no new disclosure. Deliberately no mutual counts: search takes an arbitrary
  handle, and answering "how many mutuals" for arbitrary handles is a
  graph-inference oracle.
- `@osn/api`: organisation results follow the same two-phase shape and share
  the ranking function, but carry no exclusions — organisations are public, and
  the caller's own are *more* relevant in a search box, so they come back
  flagged `isMember: true` and render a badge instead of a CTA. Results are
  addressed by **handle**, not the internal `org_*` id: `GET
  /organisations/:handle` resolves by handle and the public `orgProjection`
  omits the id. Chasing that down also turned up a pre-existing bug —
  `OrganisationsPage` linked `/organisations/${org.id}` against that same
  id-less projection, so every organisation row navigated to
  `/organisations/undefined`. Fixed in passing.
- `@osn/api`: `suggestConnections` gains organisation co-members as a second
  signal, so an account with no connections yet has something to act on — FOF
  alone returns nothing until the first connection is accepted. Suggestions now
  carry a `reason` (`mutual_connections` | `shared_organisation`) naming the
  strongest signal plus the shared organisation as card context, and rank by
  mutual count, then shared-organisation count, then profile id for stable
  ties. Two fixes fell out of the rework: an edge in *any* state now excludes a
  candidate (a pending request used to keep the person in Discover behind a
  Connect button that could only fail with "Connection already exists"), and
  the hydrate step joins `accounts` so a profile mid-erasure is never
  suggested.
- `@osn/api`: the recommendations route factory now takes a
  `RecommendationRateLimiters` pair instead of a single backend —
  `createRedisRecommendationRateLimiters` supplies `recs:read` at 20/user/min
  for the fan-out and `recs:search` at 60/user/min for typeahead, which fires
  once per debounced keystroke and would otherwise 429 a user mid-word. Both
  stay per-user and fail-closed.
- `@osn/client`: `createRecommendationClient` gains `search`, returning people
  and organisations together and taking an `AbortSignal` so a caller can cancel
  a superseded keystroke; `Suggestion` gains `reason` and `sharedOrganisation`.
- `@osn/social`: search now lives in the shell rather than on one page.
  `GlobalSearch` is an ARIA combobox in the desktop rail — arrow keys move
  `aria-activedescendant` across both sections without leaving the field, Enter
  acts on the active row (Connect / Accept for a person, navigate for an
  organisation), Escape closes. The new `/search` page groups results under
  section headings and is the mobile shell's **Search tab**: the bottom bar is
  the thumb-reachable surface, where a header field is not. `NAV_ITEMS` gained
  a `mobileOnly` flag so the rail — which has the live field — doesn't also
  carry the link, and Discover's icon moved from a magnifier to a person-plus
  so the tab bar doesn't show two magnifiers. Both surfaces share one
  `createSearchController` (debounce, abort, optimistic status), so a row's
  state flips locally on success rather than refetching and reordering the list
  under the cursor — and a failed request renders an error instead of spinning
  forever, since Solid's `resource.latest` rethrows in the error state unless
  the error is read first. The two surfaces run different ARIA patterns on
  purpose: the rail is a combobox whose options carry no operable descendants
  (a listbox option is flattened to its accessible name, so a nested button is
  unreachable to assistive tech), while the page is a plain list with real
  buttons. Discover is now suggestions-only, its cards rendering the
  reason line ("3 mutual connections" / "Also in Acme Inc").
