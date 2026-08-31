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
last-reviewed: 2026-08-31
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

**List asymmetry (by design, not a bug):** `listPendingRequests` /
`GET /graph/connections/pending` returns only requests *received* by the
caller (`addresseeId = caller`); it never includes ones the caller sent.
`listConnections` / `GET /graph/connections` returns only `status: "accepted"`
rows. Until 2026-08-07 this meant a sender had no page anywhere in
`@osn/social` that showed their own outstanding requests — reported as "I
connected with someone and it didn't work, don't see it in pending or
accepted," even though the request was persisted and visible on the
recipient's side the whole time. Fixed by adding the symmetric
`listOutgoingRequests` / `GET /graph/connections/sent` (filters
`requesterId = caller AND status = "pending"`) and a "Sent" tab on
`ConnectionsPage` in `@osn/social`, whose Cancel action reuses
`removeConnection` (it already cancels a pending request in either
direction — no new endpoint needed for cancel).

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

Graph routes use `safeError` (built via `makeSafeError` in `osn/api/src/lib/safe-error.ts`) so that only `GraphError` and `NotFoundError` messages reach clients (S-M17). Raw DB/Effect errors never leave the server. Error objects logged via `Effect.logError` go through `safeErrorSummary()` which extracts only `_tag` + `message` (S-L9).

`makeSafeError` is `FiberFailure`-aware: handlers run service effects through `ManagedRuntime.runPromise` (see `makeAppRunner`), which rejects with a `FiberFailure` wrapping the typed failure — never the tagged error itself. The earlier per-route `safeError` copies checked `_tag` on the caught value directly, so the check never matched and every business-rule failure ("Connection already exists", "Cannot connect to yourself", …) reached clients as the generic "Request failed" — surfacing in `@osn/social` as an unexplained "Request failed" toast on Connect. The helper unwraps the cause first (`Runtime.isFiberFailure` → `Cause.failureOption`), then applies the tag allowlist. The organisation routes share the same helper with `OrgError`/`NotFoundError`. Regression tests: `tests/lib/safe-error.test.ts`, `tests/routes/graph-error-messages.test.ts`, `tests/routes/organisation-error-messages.test.ts`.

Two properties of the allowlist are deliberate:

- **Messages are static literals only.** Because allow-listed messages reach clients verbatim, every `GraphError`/`OrgError`/`NotFoundError` construction must use a hardcoded string — never an interpolated cause or user input. The constraint is stated on the error classes and pinned by `tests/lib/safe-error-static-messages.test.ts`.
- **Block detectability is accepted.** A blocked requester's `POST /graph/connections/:handle` returns "Cannot send connection request", which is distinguishable from "Connection already exists" — so a determined user can infer they were blocked. This is the standard social-platform trade-off (block state is inferable through other channels regardless) and is intentional, not a leak.

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
   - **Friends-of-friends** — accepted connections of the caller's first 500 accepted connections, capped at **10 000 rows**. The query reads that seed set through a correlated `IN (<subquery>)` rather than binding the 500 ids as literals — see **D1's bound-parameter cap**, below, for why.
   - **Organisation co-members** — members of the caller's organisations, capped at **2 000 rows total**, split evenly across the caller's organisations (`MAX_ORG_COMEMBER_ROWS` divided by how many organisations the caller belongs to) so one organisation can no longer absorb the whole budget and starve the rest (osn-tracker#574).
4. Tally `mutualCount` and shared organisations per candidate in JS with an O(1) `Set` on the caller's direct connections.
5. Rank by mutual count desc, then shared-organisation count desc, then profile ID (stable ties). Slice to `limit` (bounded `[1, 50]` at the HTTP boundary).
6. Re-check the survivors, fresh, against `connections` and `blocks` — dropping anyone now actually connected, pending, or blocked — before hydrating (osn-tracker#589 follow-up, S-H1; see below).
7. Hydrate the survivors via `users ⋈ accounts WHERE deleted_at IS NULL`, so a tombstoned account is never suggested.

### The fresh re-check before hydration (S-H1)

Steps 1 and 2 are two separate, un-transacted D1 round trips — nothing joins them in a `db.batch`/`db.transaction`. Step 1 snapshots the caller's own edges; step 2's friends-of-friends seed subquery re-reads `connections` live, at whatever the table holds when step 2 actually runs. The `IN (<subquery>)` rewrite above closed osn-tracker#589's bind-cap crash, but it opened a window the old, single-snapshot query structurally could not have: if the caller accepts a new connection between step 1 and step 2 — the same account, a second request in flight from another tab or device — that connection's id was never seen by the step-1 snapshot, so it is in neither the caller's own-connections set nor the exclusion set, yet it is inside the live seed subquery's result. The fan-out row for that brand-new edge was misclassified as a candidate rather than a mutual connection, and nothing downstream re-checked it: the caller's own newest connection could come back as "someone you may know." `profileId` is always the caller's own, so the blast radius is one account's freshest edge against itself — never another account's connection or block state.

Fixed by re-checking, fresh, immediately before hydration, for just the ids that survived ranking (step 5's `sorted`, at most `safeLimit` ≤ 50) — small enough that this cannot reopen the 100-bound cap. That safety is measured, not assumed: naively filtering with `or(inArray(requesterId, ids), inArray(addresseeId, ids))` binds the id list twice, the same mistake #589 fixed, and at the 50-id ceiling that is 102 params (`.toSQL()` against the real query shape: 2 profile-id equality binds + 2 × 50-id `inArray`s) — over D1's cap. The re-check queries instead run the id filter once each, against a subquery that projects the counterpart id, so the list is bound once: 3 profile-id binds (one in a `CASE`, two in the seed `WHERE`) + up to 50 for the single `inArray` = 53 params, confirmed the same way.

`db.batch()` across steps 1 and 2 was considered instead and rejected without running it: D1's docs do not state that a batch is snapshot-isolated against a concurrent write from a different request, and this repo has already taken an unverified engine property on faith three times (see the bound-parameter cap below, and the compound-select arm limit) — a bounded re-check needs no such assumption, since it is correct whether or not D1 batches are isolated.

No backfill: a dropped candidate is not replaced from the next rank down — that would be a recall decision, not this fix's job. The caller sees a list one entry shorter on the rare request that races its own second tab, never a wrong one.

Each suggestion carries a `reason` (`mutual_connections` | `shared_organisation`) naming the strongest signal, plus `sharedOrganisation` as card context when there is one. `reason` is what the Discover card turns into "3 mutual connections" or "Also in Acme Inc".

`GET /recommendations/connections` also returns `generatedAt` (ISO 8601, set at request time) alongside `suggestions`, so a client can tell how fresh a list is (osn-tracker#311). The list itself is still never cached or stored server-side — a short-lived cache is the separate, not-yet-decided osn-tracker#588.

Current shape prioritises correctness + bounded cost over peak throughput. Next steps are open issues in `xchromo/osn`:

- **P-W6** — short-lived per-caller cache (5-15 min) so a Discover-page visit doesn't re-run the pipeline.
- **P-W7** — push aggregation to SQL (`GROUP BY … ORDER BY … LIMIT`) is still open. This line used to also propose two compound indexes, `connections(status, requester_id)` / `connections(status, addressee_id)` — **don't add them.** Measured on real D1: the existing `connections_requester_idx` / `connections_addressee_idx` already give a MULTI-INDEX OR, and the proposed indexes cut rows_read only 120 → 112 (about 7%) — and on a fresh un-`ANALYZE`d database the planner instead picked `(status, addressee_id)` and scanned every accepted edge, a strict regression. `status` has two values; it is the worst possible leading column. The measurements are recorded on osn-tracker#312 and #278. If a real need is ever proven, the right shape is `(requester_id, status, addressee_id)` — the selective column first, not `status`.

Privacy: the endpoint returns `mutualCount` alongside each suggestion. This leaks graph-inference signal — see `S-L4` in `xchromo/osn-tracker` for the bucketing follow-up.

Rate-limited at 20 req/user/min via `createRedisRecommendationRateLimiters().suggest` — see [[rate-limiting]].

### D1's bound-parameter cap (standing constraint)

D1 caps a query at **100 bound parameters** (developers.cloudflare.com/d1/platform/limits/, applied per statement, including inside a `batch()`). `bun:sqlite` — what the rest of the OSN test suite runs on — enforces no such cap, so a query that binds a caller-controlled list can pass every unit test and still fail in production. This bit the FOF fan-out directly: `inArray(requesterId, myConnectionIds) OR inArray(addresseeId, myConnectionIds)` bound `myConnectionIds` twice, so 51 accepted connections already produced 102 binds, and `GET /recommendations/connections` threw `D1_ERROR: too many SQL variables` for any caller past 50 (osn-tracker#589).

The fix: bind `profileId`, not the list. The FOF query now reads the caller's own accepted edges through a correlated `IN (<subquery>)` — the subquery re-reads them inside the database, so the outer query's bind count is fixed regardless of how many connections the caller has. A correlated `EXISTS` (the more obvious rewrite) was measured and rejected: on real (Miniflare/workerd) D1, `EXPLAIN QUERY PLAN` showed it planning as `SCAN c` with a `CORRELATED SCALAR SUBQUERY` evaluated once per row of the *whole* `connections` table — cost that scales with the size of the table, not with the caller's own graph. The `IN (<subquery>)` shape gets flattened by SQLite into a `LIST SUBQUERY` — one indexed pass to build a Bloom filter, then the same `MULTI-INDEX OR` seek over `connections_requester_idx` / `connections_addressee_idx` the original query got. Measured on a caller with 40 accepted connections: 484 rows read against the two-`inArray` shape's 400, for an identical result set — the cost of materialising the seed set once rather than pasting it in as literals.

Any query in this file — or elsewhere in `@osn/api` — that binds a list whose length comes from user data must either keep that list under 100 items by construction (an HTTP-boundary bound, like `safeLimit`), or avoid binding it at all (a subquery, as above, or genuine batched round-trips under the cap each). The chunk-and-`UNION ALL`-in-one-statement version does **not** work: a `UNION ALL` of several `inArray` arms is still one statement, so D1's cap applies to the combined total, not per arm. Only real, separate round trips (or a subquery that runs inside the database) get around it. New D1-backed coverage of a fix like this belongs in `osn/api/src/d1-integration.test.ts` — it is the only test file in this repo that runs against a real (Miniflare/workerd) D1 rather than `bun:sqlite`, so it is the only place either failure mode (the bind cap, or `rows_read`) is visible at all.

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
