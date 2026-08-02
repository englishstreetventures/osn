---
title: Social Graph
aliases:
  - connections
  - graph service
  - relationships
tags:
  - systems
  - social
  - identity
status: current
related:
  - "[[pulse-close-friends]]"
  - "[[s2s-patterns]]"
  - "[[osn-core]]"
  - "[[event-access]]"
packages:
  - "@osn/api"
  - "@osn/db"
last-reviewed: 2026-08-02
---

# Social Graph

The social graph is OSN's core relationship system. It manages connections and blocks between users. All graph logic lives in `@osn/api` with the schema in `@osn/db`.

> **Close friends moved to Pulse.** OSN core no longer owns a close-friends list — each app that wants one owns its own table and validates membership against this graph. See [[pulse-close-friends]].

## Relationship Types

### Connections (bidirectional)

A connection is a mutual relationship between two users. It requires both parties to agree.

**Flow:** request -> accept/decline/cancel

- Either user can send a connection request
- The recipient can accept or decline
- The sender can cancel a pending request
- Either party can remove an accepted connection

### Blocks (unidirectional)

A block is a one-way action. When A blocks B:
- The block removes any existing connection between A and B (wrapped in a DB transaction after P-W17)
- B cannot send connection requests to A
- Blocks are global across all OSN apps today (per-app blocking is a deferred decision)

The `is-blocked` route only checks whether the caller has blocked the target (`isBlocked(caller, target)`) -- it does not reveal whether the target has blocked the caller (S-M15).

## Architecture

```
osn/api/src/services/graph.ts     # Graph service (Effect-based)
osn/api/src/routes/graph.ts       # Graph routes (Elysia)
osn/db/src/schema.ts               # connections, blocks tables
```

The graph service exports functions like:
- `sendConnectionRequest`, `acceptConnection`, `declineConnection`, `cancelConnection`, `removeConnection`
- `blockProfile`, `unblockProfile`, `isBlocked`, `eitherBlocked`
- `getConnections`, `getPendingRequests`, `getBlocks`

## Test Coverage

Tests covering services and routes. Test areas include:
- Connection lifecycle (request, accept, decline, cancel, remove)
- Block behaviour (directional checks)
- Rate limiting on graph write endpoints
- Error handling (not found, already exists, self-referential operations)
- Input validation (handle regex, length bounds via TypeBox `HandleParam`)

## Rate Limiting

All graph write endpoints are rate-limited at 60 requests per user per minute (S-M16). Graph routes accept injected rate-limiter instances -- part of the [[redis]] migration Phase 1 abstraction work.

## Cross-Package Access

Other packages (notably `@pulse/api`) access the social graph through `graphBridge.ts` -- see [[s2s-patterns]] for the full pattern. The bridge exports:

- `getConnectionIds(profileId)` -- accepted connections set
- `getProfileDisplays(profileIds[])` -- batched profile metadata join

Apps that own a close-friends-style list (e.g. Pulse — see [[pulse-close-friends]]) call `getConnectionIds` to validate eligibility when adding a friend.

## Error Handling

Graph routes use `safeError()` so that only `GraphError` and `NotFoundError` messages reach clients (S-M17). Raw DB/Effect errors never leave the server. Error objects logged via `Effect.logError` go through `safeErrorSummary()` which extracts only `_tag` + `message` (S-L9).

## Input Validation

The `:handle` route parameter uses TypeBox `HandleParam` with regex + length bounds (S-M18). This prevents injection and ensures handles conform to the reservation rules.

## Performance Notes

- N+1 queries in graph list functions replaced with `inArray` batch fetches (P-W6)
- `eitherBlocked` collapsed from two sequential `isBlocked` calls to a single OR query (P-W7)
- `blockProfile` replaced SELECT-then-DELETE with direct `DELETE WHERE OR` (P-W8)
- `removeConnection` and `blockProfile` wrapped in DB transactions (P-W17)

## Recommendations (contact suggestions)

`createRecommendationService().suggestConnections()` powers the "Suggested for you" surface on the `@osn/social` Discover page. Two signals feed it — mutual connections (the stronger one) and shared organisations (the one a brand-new account actually has):

1. Read the caller's own edges (**any** status, capped at 1 000 rows), blocks in both directions, and organisation memberships (capped at 50) — concurrently.
2. Build the exclusion set: self, every counterpart on an existing edge, and everyone blocked either way. Pending edges count, so a request already in flight never resurfaces as a suggestion whose Connect button would fail with "Connection already exists".
3. Fan out twice, each branch skipped when its seed set is empty:
   - **Friends-of-friends** — accepted connections of the caller's first 500 accepted connections, capped at **10 000 rows**.
   - **Organisation co-members** — members of the caller's organisations, capped at **2 000 rows**.
4. Tally `mutualCount` and shared organisations per candidate in JS with an O(1) `Set` on the caller's direct connections.
5. Rank by mutual count desc, then shared-organisation count desc, then profile ID (stable ties). Slice to `limit` (bounded `[1, 50]` at the HTTP boundary).
6. Hydrate the top N via `users ⋈ accounts WHERE deleted_at IS NULL`, so a tombstoned account is never suggested.

Each suggestion carries a `reason` (`mutual_connections` | `shared_organisation`) naming the strongest signal, plus `sharedOrganisation` as card context when there is one. `reason` is what the Discover card turns into "3 mutual connections" or "Also in Acme Inc".

Current shape prioritises correctness + bounded cost over peak throughput. Next steps tracked in `wiki/TODO.md`:

- **P-W6** — short-lived per-caller cache (5-15 min) so a Discover-page visit doesn't re-run the pipeline.
- **P-W7** — push aggregation to SQL (`GROUP BY … ORDER BY … LIMIT`) and add compound indexes `connections(status, requester_id)` / `connections(status, addressee_id)`.

Privacy: the endpoint returns `mutualCount` alongside each suggestion. This leaks graph-inference signal — see `wiki/TODO.md` → S-L4 for the bucketing follow-up.

Rate-limited at 20 req/user/min via `createRedisRecommendationRateLimiters().suggest` — see [[rate-limiting]].

## Search (autocomplete)

`GET /recommendations/search?q=&limit=&orgLimit=` backs every search surface in `@osn/social`. It answers with **both** sections in one round trip — `people` from `searchProfiles()` and `organisations` from `searchOrganisations()`. One endpoint rather than two because this is typeahead: one request per keystroke means one abort to cancel, one rate-limit budget to reason about, and no torn state where the people half of a result set is newer than the organisation half.

Both halves follow the same shape, and it is [Facebook's typeahead tiering][fb-typeahead]: retrieve the caller's own graph first, then the global index, then score the whole candidate set on **text match + social proximity** before slicing the page.

[fb-typeahead]: https://engineering.fb.com/2010/05/17/web/the-life-of-a-typeahead-query/

### People (`searchProfiles`)

The user-facing sibling of the ARC-gated `/graph/internal/profile-search`. The two share the same guardrails but not the same auth.

- **Normalisation** — trim, strip a leading `@`, lowercase, then **tokenise**. `users.handle` is stored lowercase, so `@Alice` and `alice` are the same search. LIKE wildcards in the typed query are escaped so a typed `_` or `%` matches literally — and the tokeniser deliberately keeps **every LIKE metacharacter** (`%`, `_`, `\`) inside the token for exactly that reason: `escapeLike` can only neutralise a character that survives tokenisation, so treating `%` as a separator would turn `"a%b"` into `a` + `b` and convert the one wildcard the escape exists to defuse back into a wildcard. Ordinary punctuation *does* split (`"Smith, John"` has to tokenise the way a person reads it) — it is not a metacharacter, so dropping it cannot widen a pattern; it only shortens the token, which is why every length gate is computed from the tokens.
- **A query is three things**, computed once per request: the `phrase` (verbatim), its `tokens` (`"john smith"` → `["john", "smith"]`), and the `handleQuery` those tokens spell (`"johnsmith"`). The rejoin matters: a space cannot prefix a handle, so before it a multi-word query skipped the index seek entirely and found `@johnsmith` only if the infix scan happened to run.
- **Query length gates scope, not access** — the floor is now **1 character**, but what a character *reaches* widens in three steps: 1 char searches only the caller's own edges, 2 unlocks the global handle seek, 3 unlocks the name scan. The old flat minimum of 2 existed to stop one keystroke walking the handle namespace; scoping the first keystroke to a set the caller can already enumerate (`GET /graph/connections`) achieves that without costing the answer.
- **Each gate measures the thing it gates, never the raw query** (S-M1, caught in prep-pr review of this change). The prefix pass compares `MIN_GLOBAL_QUERY_LENGTH` against `handleQuery` — the string actually bound into the range — and the infix pass compares `MIN_INFIX_QUERY_LENGTH` against the **longest token**. Measuring `phrase.length` instead is a bypass, because tokenisation drops separators: `"a."` is two characters of phrase carrying a one-character prefix, and `"a a"` three carrying a one-character infix, so a phrase-length gate opens exactly the one-character global reads the tiering exists to prevent. Per token rather than over the whole query, because an `AND` of `LIKE` patterns is only as selective as its most selective conjunct — `"a b c"` must not scan, `"j smith"` must.
- **The infix threshold is script-aware** (`hasScanworthyToken`). A minimum-*length* gate is a proxy for a minimum-*selectivity* gate, and character count is only a good proxy inside one alphabet: two Han characters pick a name out of a very large space where two Latin letters barely narrow anything. A flat three-character rule made `"日本 太郎"` — a complete name whose every token is two characters — unsearchable, so tokens in Han, Hiragana, Katakana or Hangul clear the gate at two. Diacritics do **not** qualify: `"mü"` narrows about as much as `"mu"`. This was caught by writing the non-ASCII test the review asked for, and it was a regression *introduced* by keying the gate on token length — the previous phrase-length gate happened to let CJK through for the wrong reason.
- **Token count is capped** at `MAX_QUERY_TOKENS` (6) before any SQL is built (S-M2). Each token emits its own ANDed pair of `LIKE` predicates, and `q`'s 64-character bound admits 32 single-character tokens — 64 pattern evaluations per scanned row, on a conjunction that matches nothing so `LIMIT` never short-circuits. Four tokens spells "maria del carmen rodriguez"; the cap is invisible to real queries.
- **Why a range and not `LIKE 'q%'`** — because `LIKE` does not use the index. SQLite's LIKE-prefix optimisation needs the indexed column's collation to match LIKE's case sensitivity; `case_sensitive_like` is off by default (D1 runs stock defaults) and both `users_handle_idx` and the implicit unique index on `organisations.handle` are BINARY, so the planner degrades to a full traversal. Measured with `EXPLAIN QUERY PLAN`:

  ```
  handle LIKE 'ab%' ESCAPE '\'      ->  SCAN users USING INDEX users_handle_idx     (full)
  handle >= 'ab' AND handle < 'ac'  ->  SEARCH users USING INDEX users_handle_idx   (seek)
  ```

  The two are exactly equivalent here — handles are stored lowercase and constrained to `^[a-z0-9_]+$`, and the query is lowercased — so this is a pure planner win, no semantic change. A query containing anything outside that character set can't prefix a handle at all and skips pass 1 entirely (`handlePrefixRange` returns `null`).

  `handlePrefixRange` lives in **`@shared/db-utils/search`** alongside `normaliseHandleQuery`, `escapeLike`, `likeContains`, and the tokenisers `tokeniseQuery` / `joinTokens` / `tokensPrefixName`. It was private to `recommendations.ts` until 2026-08-02, which is exactly why the ARC-gated `/graph/internal/profile-search` kept the `LIKE` full scan for as long as it did (backlog item P-I `internal-profile-search-scan`, now closed) — the knowledge existed but wasn't reachable. Every handle-prefix match in the monorepo now goes through the one helper; consumers are this service, both internal graph search endpoints, and cire's vendor directory browse (`likeContains` only — its search is substring-over-names, which no range can express).
- **Pass 2 is gated twice** — it runs only when the passes above under-fill the page *and* the query is ≥ 3 characters (`MIN_INFIX_QUERY_LENGTH`). No index can serve a leading wildcard, so this is a genuine full scan; a two-character infix is simultaneously the cheapest query to abuse and the least selective, so the scan is reserved for real "I typed part of a surname" recovery. Prefix matching still works from 2 characters. It matches **every token** (`%john%` AND `%smith%`) rather than one `%john smith%` pattern, so `"Smith, John"` and `"smi joh"` are findable — one substring pattern can only ever match one order.

#### Pass 0 — the caller's own edges

An index seek on `connections_requester_idx` / `connections_addressee_idx` joined to `users`, matched loosely (every token appearing anywhere in handle or display name), capped at `MAX_CONNECTION_MATCH_ROWS` (50). Two queries, one per edge direction, because SQLite will not use either index for a disjunction spanning both — a pass whose whole justification is being cheap must not degrade into a scan of `connections`.

It is not a duplicate of the global passes: it is a **recall guarantee**. Every global pass is `ORDER BY handle LIMIT overfetch`, so a common prefix fills the window with whoever sorts alphabetically first — search `"pa"` on a large instance and a connection whose handle sorts behind forty strangers never enters the candidate set at all, no matter how the survivors are ranked. A caller's connections are few enough to retrieve unconditionally, so they never compete for that window.

#### Ranking

Text score plus proximity score, summed, over the whole candidate set **before** the slice. Scoring pre-slice is the structural change: connection state used to be fetched for the already-chosen page, so proximity could only relabel results that text ranking had picked without it.

| Text (`lexicalScore`) | | Proximity (`PROXIMITY_SCORE`) | |
|---|---|---|---|
| exact handle | 100 | connected | +40 |
| handle prefix | 60 | pending either way | +25 |
| **name-token prefix** | 50 | shared organisation | +15 |
| handle infix | 25 | | |
| name infix | 20 | | |

Ties break on text score alone, then handle, so the order is total and stable between identical requests.

**Why the name-token tier.** Surnames are not prefixes of full names. Before it, `"Roberta Smith"` scored for `"smith"` as a name *infix* — indistinguishable from `"Blacksmith Ltd"`, and ranked *below* `@blacksmith`. Matching any token of a name is what a name-based typeahead has to do.

**Why summed rather than lexicographic.** Neither pure ordering is right. Text-first buries the caller's own connections under strangers with a marginally better prefix — the thing typeahead most needs to avoid. Proximity-first lets a connection matched on a name infix outrank a stranger whose handle the caller typed in full. Summing lets each outweigh the other where it should: an exact handle (100) beats a connected handle prefix (60 + 40) on the text tie-break, while a connected name-token match (50 + 40) beats a stranger's handle prefix (60).

**Why no friends-of-friends**, though it is the strongest signal Facebook's own ranking uses. Nothing in OSN exposes another profile's connection list, so a mutual-connection boost would make result *ordering* an oracle for "is this arbitrary handle a friend-of-a-friend?" — the same disclosure that keeps `mutualCount` out of the payload (S-L4). Ordering leaks as readily as a field does. The two signals that *are* used both describe things the caller can already read directly: connection state ships in the response already, and shared organisations are only ever counted for organisations the caller belongs to, whose member list is visible to members.
- **Exclusions** — self, tombstoned accounts (`accounts.deleted_at IS NULL` join), and anyone blocked in either direction. The block check is a **bounded probe against the candidate ids**, not a wholesale read of the caller's blocks: an unbounded read scales with how many people the caller has blocked rather than with anything the request needs, and both `blocks_blocker_idx` and `blocks_blocked_idx` serve the probe. Filtering still happens in application code (over an over-fetched candidate set) so the page stays full.
- **Connection state** — each result carries the caller's own state with it (`none` / `pending_sent` / `pending_received` / `connected`), batched in one query for the whole page, so the UI renders Connect / Accept / Requested / Connected without a request per row. This is the same fact `GET /graph/connections/:handle` already reports per handle — no new disclosure, just fewer round trips.
- **No mutual counts.** Deliberate: suggestions describe profiles already adjacent to the caller's graph, but search takes an *arbitrary* handle, and answering "how many mutuals" for arbitrary handles is a graph-inference oracle (cf. S-L4).

### Organisations (`searchOrganisations`)

Same two-phase shape — anchored `handle LIKE 'q%'`, then an unanchored pass over handle + name only when the first under-fills — and the same normalisation, LIKE-escaping and minimum length. Ranking is shared with people search via `matchRank`, so the two lists sort on identical rules.

Differences from people search, all deliberate:

- **No exclusions.** Organisations are public entities whose handles share a namespace with user handles, and the caller's *own* organisations are more relevant in a search box, not less — they come back flagged `isMember: true` so the row renders a badge instead of a CTA, and membership is worth `+15` in the score so it can change *which* organisations make the page rather than only how the chosen ones are labelled.
- **Addressed by handle, never by `org_*` id.** `GET /organisations/:handle` resolves by handle (`getOrganisationByHandle`) and the public `orgProjection` deliberately omits the id, so returning one would both widen that surface and hand the client a key nothing accepts. (Finding this is what surfaced a **pre-existing bug**: `OrganisationsPage` linked `/organisations/${org.id}` against a projection with no `id`, so every organisation row navigated to `/organisations/undefined` → 404. Fixed to link by handle in the same change.)

### Budget

Rate-limited at 60 req/user/min via `createRedisRecommendationRateLimiters().search` — looser than the suggestion budget because typeahead fires once per debounced keystroke, and a 20/min budget would 429 a user mid-word. The client debounces 250 ms and aborts superseded requests. `orgLimit` defaults to half `limit`: organisations are the secondary section in the UI.

Query count per people search is 3-6 (two edge-direction seeks, the handle range, optionally the infix scan, then blocks / connection state / shared organisations). The last three are one `Effect.all` rather than the two sequential steps this used before, so the request has **one fewer sequential database step** than the pre-proximity version despite carrying more signal — parallel on D1, sequential on bun:sqlite. Candidate ids peak near 170 at the maximum page size, which keeps the bound-parameter count in the probes under SQLite's 999 ceiling.

## Source Files

- [osn/api/src/services/graph.ts](../../osn/api/src/services/graph.ts) -- graph service
- [osn/api/src/services/recommendations.ts](../../osn/api/src/services/recommendations.ts) -- contact suggestions + people/organisation search (retrieval passes, `lexicalScore`, `PROXIMITY_SCORE`)
- [osn/api/src/routes/graph.ts](../../osn/api/src/routes/graph.ts) -- graph routes
- [osn/api/src/routes/recommendations.ts](../../osn/api/src/routes/recommendations.ts) -- `/recommendations/connections` + `/recommendations/search`
- [osn/social/src/lib/search.ts](../../osn/social/src/lib/search.ts) -- shared client search controller (debounce, abort, optimistic status)
- [osn/social/src/components/GlobalSearch.tsx](../../osn/social/src/components/GlobalSearch.tsx) -- desktop rail search combobox
- [osn/social/src/pages/SearchPage.tsx](../../osn/social/src/pages/SearchPage.tsx) -- `/search`, the mobile Search tab
- [shared/db-utils/src/search.ts](../../shared/db-utils/src/search.ts) -- shared query primitives (normalisation, LIKE escaping, prefix ranges, tokenisers)
- [osn/db/src/schema.ts](../../osn/db/src/schema.ts) -- schema (connections, blocks)
- [osn/api/tests/services/graph.test.ts](../../osn/api/tests/services/graph.test.ts) -- service tests
- [osn/api/tests/services/recommendations.test.ts](../../osn/api/tests/services/recommendations.test.ts) -- recommendations tests
- [osn/api/tests/routes/graph.test.ts](../../osn/api/tests/routes/graph.test.ts) -- route tests
