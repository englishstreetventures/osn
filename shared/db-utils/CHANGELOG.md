# @utils/db

## 0.7.1

### Patch Changes

- 6474854: Fix every `house/no-stacked-doc-block` site in these packages (xchromo/osn#926).

  A declaration with two or more leading doc blocks only has its last block attached — the earlier one silently documents nothing, and an editor hovering the declaration never shows it. Two shapes accounted for all 26 sites across these packages: a genuine module doc that had been placed after the file's `import` line rather than at line 1, which the rule's module-block exemption checks literally, and so read as stacked in front of whatever the doc block happened to precede — moved to line 1, restoring both blocks to their correct attachment; and two doc blocks that were both actually describing the same declaration, split apart for no good reason — merged into one, with content preserved and no duplication.

  No prose was rewritten and no behavior changed. Every fix was spot-checked by an independent adversarial pass against the real diff before being applied, confirming no content was lost and every surviving block attaches to the declaration it actually describes.

## 0.7.0

### Minor Changes

- d3af349: Move every Effect dependency to 4.0.0-rc.112 and convert the service keys.

  `effect`, `@effect/vitest` and `@effect/opentelemetry` are pinned to one exact
  version, because v4 releases the ecosystem under a single version number and is
  still pre-GA — a caret range would let an install move the target mid-migration.
  `@effect/platform` is dropped: v4 merged it into core, and nothing here imported
  it.

  `Context.Tag` no longer exists. Class declarations become
  `Context.Service<Self, Shape>()(id)` — note the argument order flips — and the
  `Context.Tag<any, A>` parameter types in `@shared/db-utils` become
  `Context.Key<any, A>`. Every service identifier string is unchanged, since those
  are the runtime lookup keys. Call sites are untouched: a v4 service key still
  extends `Effect`, so `yield* Db` works as before.

  This is the first phase of the Effect v4 migration and does not stand alone —
  the tree does not type-check until the `Schema` work lands.

### Patch Changes

- d3af349: Pin the search string-math with property tests, and let Effect own the Redis
  startup deadline.

  `search.ts` states its invariants in doc comments as facts — `handlePrefixRange`
  claims to be _exactly equivalent_ to `handle LIKE 'q%'` — and an example-based
  test can only check the cases someone thought of. Three properties now hold that
  claim to account: range membership is exactly prefix matching, `escapeLike`
  round-trips (and leaves no unescaped metacharacter behind), and `tokeniseQuery`
  never drops a `%`, `_` or `\` before `escapeLike` can neutralise it. All three
  were true. They are mutation-checked rather than assumed: each goes red against
  a deliberately broken variant, including the closed-vs-half-open range mutant
  that the first generator missed, because no generated handle could land exactly
  on the bound.

  No new dependency: `fast-check` already ships inside `effect`, reached via
  `effect/testing`. The handle generator is derived with `Schema.toArbitrary` from
  the same `^[a-z0-9_]+$` pattern the source constrains itself to, so it restates
  the constraint instead of duplicating it.

  `shared/redis/src/ioredis.ts` replaces a hand-rolled `Promise.race` deadline
  with `Effect.timeoutOrElse` — `timeoutOrElse`, not plain `timeout`, because the
  latter widens the error channel to `RedisError | TimeoutError` and fails the
  layer's declared `Layer.Layer<Redis, RedisError>`. The failure mode is
  byte-identical: one `Fail` carrying `RedisError { cause: "Redis startup ping
timed out" }`. That matters more than it looks — the limiters fail closed, so a
  changed timeout path surfaces as rejected requests rather than an obvious crash.

  `health.ts` keeps its `Promise.race`: it is a bare `async function` on the
  public barrel, awaited inside a `try/catch` by two composition roots that also
  disconnect and rethrow, so converting it would either put a per-call
  `Effect.runPromise` in a function with no `ManagedRuntime` — against the
  build-the-layer-graph-once rule — or ripple through both `initRedisClient`
  implementations and three test files.

  Also adds the first test for `RedisLive` itself, which had none.

## 0.6.6

### Patch Changes

- 613c916: Stop six pulse queries binding one parameter per element against D1's cap.

  D1 allows 100 bound parameters per query. A `SELECT` binding an id list broke
  past 50-100 items; a multi-row `INSERT`, which binds one parameter per column
  per row, broke an order of magnitude sooner. Six sites were affected, and three
  were live: recurring series failed to materialise past three instances, the RSVP
  list broke for every viewer of a well-attended event, and a GDPR erasure could
  never complete for an account that had hosted more than a hundred events.

  `@shared/db-utils` gains `jsonEachIn` and `insertManyViaJsonEach`, which bind the
  whole array as one JSON parameter and unpack it inside SQLite with `json_each`.
  Both are verified against real Miniflare-backed D1 rather than bun:sqlite, which
  enforces no such cap and so passes against every one of these bugs.

## 0.6.5

### Patch Changes

- 0312c9e: Take @cloudflare/workers-types 5.20260830.1 (from 4.20260702.1). This also fixes a peer range nobody had noticed: wrangler 4.127.1 declares an optional peer on `@cloudflare/workers-types` `^5.20260722.1`, which the old `^4.20260702.1` pin did not satisfy. Types only, no runtime change.
- d96da64: Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges.

  `fast-uri` 3.1.5 → 3.1.7. Four high advisories against 3.1.5 landed on 2026-09-02 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — two SSRF, two host confusion) and the pre-push `bun audit` gate went red. Taking 3.1.6, which is what those four advisories name as fixed, would have left two more: 3.1.7 also fixes GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port in `serialize()`) and GHSA-58mr-gqgx-xq4g (host confusion via unbalanced IP-literal brackets), neither of which is in the public advisory database yet, so no audit tool reports them. Reachability is the Astro language server only — `ajv` appears once in the lockfile, under `@astrojs/check`, and no deployed Worker or shipped bundle contains it. `smol-toml` 1.6.1 → 1.8.0 is the same shape: 1.7.1 carries the fix for GHSA-7w5x-hrqm-74c2, also absent from the database.

  The rest is lockfile lag. The dependency sweep in this stack raised every declared range, but `bun.lock` stayed behind versions those ranges already admitted: `esbuild` 0.28.2, `postcss` 8.5.26, `picomatch` 4.0.7, `sharp` 0.35.4 (libvips 1.3.3), `js-yaml` 4.3.2, `ws` 8.21.3, `devalue` 5.9.2, `happy-dom` 20.12.2, `@cloudflare/workers-types` 5.20260903.1. Two are worth knowing about rather than just taking: `ws` 8.21.1 **lowers the `maxBufferedChunks` and `maxFragments` defaults** and counts empty fragments toward the limit, which is a behaviour change inside a patch and touches Zap's WebSocket surface; `picomatch` 4.0.5–4.0.7 are all matching-semantics fixes, so glob-driven config can shift.

  `astro` 7.2.9 → 7.2.10 is the one with deployed consequences. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. It is pinned to 7.2.10 rather than left to float: 7.3.0 and 7.3.1 clear the three-day soak but not the fourteen-day rule for a minor, so they wait.

  Two overrides were correcting themselves in the wrong direction and are fixed here. `undici` was pinned `^7.29.0` while `jsdom` 30 declares `undici ^8.9.0` and `unifont` 0.7.5 declares `^8.0.0` — a floor being used as a ceiling, holding both consumers a whole major below what they were written for and cutting the tree off from undici 8 security fixes. Raised to `^8.9.0` (resolves 8.10.1). Because top-level `miniflare` 4 pins undici at exactly 7.28.0 and the wrangler-nested miniflare 5 alpha pins 7.29.0, this was verified rather than assumed: type check, the full test suite, the Miniflare D1 tier, all four Worker builds, and a real `wrangler dev --local` boot of `osn-api` on workerd, which serves 200 on `/health`, `/.well-known/jwks.json` and `/` with no errors. `postcss` and `picomatch` were likewise below what `vite` 8.2.2 asks for (`^8.5.26` and `^4.0.5`), a floor gap opened by raising vite earlier in this stack.

  Also: the `protobufjs` override matched nothing in the lockfile and is removed, and `bunfig.toml`'s note on the removed `fast-uri` soak exclusion claimed the package "parses URIs on the request path via ajv", which is not true of this tree and would have mispriced exactly the decision this changeset had to make.

  One source change, in `cire/api/tests/index.test.ts`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` a required member of `Span`, so the test's `StubSpan` gains it, typed off the interface rather than restated so the next daily types release cannot drift it.

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

## 0.6.4

### Patch Changes

- 5c51a23: Enforce foreign keys on `bun:sqlite`, and fix the two erasure bugs that were hiding behind it.

  SQLite defaults `PRAGMA foreign_keys` to **OFF** while D1 enforces them, so every local run and every test accepted writes production rejects. The cheap, fast environment was the permissive one, which is the worst way round: a statement that orphans a row, or deletes a parent before its children, passed the whole suite and would have failed on deploy.

  Turning it on found `hardDeleteAccount` broken in two ways, both of which would make GDPR Art. 17 erasure throw rather than complete. It deletes the `accounts` row while deliberately keeping `security_events` and `email_changes` under Art. 6(1)(c) — but both declared a foreign key to `accounts`, so a column documented to outlive its parent referenced it. Those two constraints are dropped. It also deleted `users` before the `oauth_consents` and `oauth_authorization_codes` rows that carry a `profile_id` referencing them; those deletes now run first.

  `dev-login`'s provisioning batch declared itself infallible through `Effect.promise` while being a chain of inserts that reference rows an earlier `onConflictDoNothing` may have skipped. With foreign keys on, that arrived as a defect and escaped the route's own error handling, answering 400 where the contract says 500 `provisioning_failed`.

## 0.6.3

### Patch Changes

- 518bc7d: Stop suppressing `no-await-in-loop` where the awaits do not actually need to be sequential.

  `commitBatch` in `@shared/db-utils` chains its bun:sqlite fallback statements instead of looping over them, keeping the children-first ordering the caller built without disabling the rule.

  In `@osn/api`, the outbound ARC key registration in `outbound-arc.ts` registered with each downstream one after the next; the downstreams are independent and registration is an idempotent upsert, so both calls now go out together and a failure on a configured stack still aborts boot. The NDJSON fan-out in `account-export.ts` reads its response with `for await` rather than a manual reader loop, which also means abandoning the generator cancels the stream instead of leaving the downstream sending a bundle nobody is reading.

  No behaviour change. The one remaining disable is the keyset pagination generator, where each page's cursor comes from the page before it.

## 0.6.2

### Patch Changes

- b219759: Dependency review: drop unused `better-sqlite3`, align stale peer ranges, bump oxfmt

  - `@shared/db-utils` no longer declares `better-sqlite3` or `@types/better-sqlite3`.
    Neither was imported by `src/` or `tests/` — the package has no drizzle-kit and no
    `db:*` scripts, so nothing there ever loaded the native module. The three `*/db`
    workspaces that do run drizzle-kit against a local SQLite file — `osn/db`,
    `pulse/db`, `zap/db` — keep theirs.
  - `@shared/osn-auth-client` peer `elysia` `^1.4.28` → `^1.4.29`, matching the range
    every other workspace declares.
  - `@shared/rp-auth` peer `solid-js` `^1.9.13` → `^1.9.14`, likewise. Both peers already
    resolved to the same version; this only stops the ranges drifting further apart.
  - Root `oxfmt` `^0.59.0` → `^0.62.0`. 0.62.0 changes how a type-annotated arrow return
    is wrapped, which reformats one file in `@pulse/api`
    (`src/services/events.ts`) — whitespace only, no behaviour change.
  - `fast-uri` dropped from `minimumReleaseAgeExcludes` in `bunfig.toml`. It was added
    for the GHSA-v2hh-gcrm-f6hx fix in 3.1.4, which shipped inside the 3-day install
    gate. The override now pins `^3.1.5` and 3.1.5 shipped 2026-07-31, so the entry
    had stopped protecting anything and was exempting every future 3.x publish.

## 0.6.1

### Patch Changes

- d4553ed: Clear every `anti-slop/no-chained-type-assertions` hit in application source and
  raise the rule from `warn` to `error`. A double assertion — `x as unknown as T` —
  tells the compiler to stop checking, so each of the 32 sites was either a type
  that could be stated honestly or a claim that was no longer true.

  Most were the second kind. `buildAppDeps` and `selectEmailLayer` now name the
  env vars they read instead of taking a loose string record, so the Workers `env`
  binding passes structurally with no cast at all. `UpstashLike` mirrors the
  `@upstash/redis` mutable array signature and the wrapper copies on the way in.
  `FLAGS` is widened once on the way out of the registry, which removes three
  casts and a `Widen` round-trip at every call site. `commitBatch` probes for
  `.batch()` with a type guard rather than asserting the driver has one.

  One was a live bug: `pulse/web`'s create-event form cast a `Date` to `string`
  and relied on `JSON.stringify` to serialise it on the way out. It now calls
  `toISOString()` where the conversion happens.

  Test files still hold 161 hits — mostly a fixture cast to the shape under test —
  so the rule stays off in the test override.

- 9f1b272: Clear every `anti-slop/no-unknown-returns` hit in application source and raise
  the rule from `warn` to `error`. A function returning `unknown` hands its caller
  a value with no contract, so every site either had a shape worth naming or was
  returning a value nobody read.

  The three `arc-middleware.ts` copies (osn, pulse, zap) now decode a JWT segment
  to text and parse it through `parseArcHeader` / `parseArcPayload`, which narrow
  with `in` checks and contain no type assertions at all. `zap-bridge.ts` gains
  four named response types and a parser per endpoint, so a malformed zap-api
  reply throws at the bridge — naming the endpoint — instead of surfacing as an
  `undefined` field several layers up. `safe-error.ts` and `grant-failure.ts`
  share a `TaggedServiceError` guard in place of duck-typed shape checks.

  `shared/redis` exports a recursive `RedisReply` and narrows ioredis's `unknown`
  through `toRedisReply()` once, at the driver boundary. `shared/observability`'s
  redactor returns a `RedactedValue` union, and `shared/openapi-tools` normalises
  through a `JsonNode` union that throws on anything JSON cannot represent.
  `@osn/ui` exports `RunPasskeyCeremony` and `RunPasskeyRegistration` so the four
  step-up call sites name the ceremony callback instead of typing it
  `(options: unknown) => Promise<unknown>`, and `@osn/client`'s two registration
  begins return `PublicKeyCredentialCreationOptionsJSON`.

  Test files still hold 18 hits, all in fetch/JSON helpers, so the rule stays off
  in the test override.

- 1ddf9bb: Clear every `anti-slop/no-unsafe-dictionary-type` hit in application source and
  raise the rule from `warn` to `error`. `Record<string, unknown>` says only "an
  object with string keys" — it accepts any key, guarantees no field, and hides
  whichever shape the code actually meant. Each of the 67 hits was one of four
  things, and each got a different fix.

  **A shape that was always known.** `@shared/crypto` exports an `Es256Jwk`
  interface and `validateEs256Jwk` asserts against it, so `importKeyFromJwk` takes
  `unknown` and does the checking itself instead of trusting a caller's cast —
  `@osn/api`'s boot path now hands it the raw string. `@osn/api`'s auth helpers
  name the four claim sets it signs (`AccessTokenClaims`, `StepUpTokenClaims`,
  `IdTokenClaims`, `OidcAccessTokenClaims`), and `verifyJwt` returns a
  `VerifiedJwtClaims` whose every field stays `unknown` on purpose: one key signs
  all four sets, so callers must still narrow on `aud`. `@pulse/api`'s account
  export becomes a discriminated union on `section`, so a reader that switches on
  the tag knows exactly which record fields it has.

  **A drizzle update set.** `@osn/api`'s organisation update and both `@cire/api`
  registry updates are typed `Partial<typeof table.$inferInsert>`, so a key that
  isn't a column fails at the assignment rather than at the D1 boundary.
  `@shared/db-utils` replaces seven `S extends Record<string, unknown>` schema
  constraints with a real `DrizzleSchema`.

  **An untrusted payload.** The CSP report normaliser, the osn-bridge org
  decoder, the crop validator and the guest claim-response guard now name the
  wire shape with every field left `unknown`, or narrow with `in` and drop the
  stand-in type entirely. Nothing gains a guarantee the wire never made.

  **A cast that was hiding a working type.** `@shared/feature-flags` uses
  GrowthBook's own `FeatureDefinitions` / `SavedGroupsValues`, which removes the
  `payload as never` at `initSync`. `@shared/observability`'s redactor and
  `@shared/openapi-tools`' normaliser drop casts their narrowing had already
  earned; `generate.ts` now throws on a non-object OpenAPI document instead of
  asserting one. `@osn/api`'s public-error walker reads through
  `Object.getOwnPropertyDescriptor` rather than indexing a widened object.

  Test files still hold 102 hits — nearly all a stub request body or a drizzle row
  the test then asserts on field by field — so the rule stays off in the test
  override.

## 0.6.0

### Minor Changes

- dea594b: Rank OSN search on social proximity and name tokens, not text alone

  `GET /recommendations/search` now follows the tiering Facebook's typeahead
  describes — retrieve the caller's own graph first, then the global index, then
  score the whole candidate set before slicing.

  - **New retrieval pass over the caller's own edges.** An index seek on the
    connection indexes joined to `users`, capped at 50 rows. It is a recall
    guarantee, not a duplicate: every global pass is `ORDER BY handle LIMIT
overfetch`, so a common prefix filled the window with whoever sorted
    alphabetically first and a connection could be missed entirely regardless of
    ranking. Organisation search gained the same pass over the caller's own
    memberships.
  - **Ranking is text score + proximity score**, summed, computed before the page
    is sliced rather than after. Connections, then pending requests, then
    co-members of an organisation the caller belongs to, outrank strangers on the
    same text tier. Friends-of-friends is deliberately excluded: nothing exposes
    another profile's connection list, so ordering by mutuals would be the same
    graph-inference oracle that keeps `mutualCount` out of the payload.
  - **Name-token prefix is now its own tier**, above handle infix. `"smith"` used
    to score `"Roberta Smith"` as a name infix — indistinguishable from
    `"Blacksmith Ltd"` and ranked below `@blacksmith`.
  - **Multi-word queries work.** Tokens are matched independently, so
    `"Smith, John"` and `"smi joh"` both find `John Smith`, and the tokens are
    rejoined to spell the handle they imply, so `"john smith"` seeks `@johnsmith`
    on the index instead of skipping the seek on account of the space.
  - **The minimum query length is 1**, down from 2. What a character reaches still
    widens in steps: 1 searches only the caller's own connections and
    organisations, 2 unlocks the global handle seek, 3 unlocks name matching.
  - The three post-retrieval probes (blocks, connection state, shared
    organisations) now run concurrently, so the request has one fewer sequential
    database step than before despite the added signal.

  `@shared/db-utils/search` gains `tokeniseQuery`, `joinTokens`,
  `tokenContentLength` and `tokensPrefixName`. The tokeniser keeps every LIKE
  metacharacter (`%`, `_`, `\`) inside the token, because `escapeLike` can only
  neutralise a character that survives tokenisation — treating `%` as a separator
  would turn `"a%b"` into `a` + `b` and convert the one wildcard the escape exists
  to defuse back into a wildcard. Ordinary punctuation still splits, so
  `"Smith, John"` tokenises the way a person reads it.

  Two findings from the pre-merge security review, both introduced and fixed on
  this branch:

  - **S-M1** — the length gates compared the raw phrase, while the SQL they gate
    is built from the tokens. Since tokenisation drops separators, `"a."` reached
    a one-character global handle seek and `"a a"` a one-character global infix
    scan, bypassing the scope rule the 1-character floor depends on. The prefix
    pass now gates on the handle prefix actually bound into the range, and the
    infix pass on the longest token — an `AND` of `LIKE` patterns is only as
    selective as its most selective conjunct.
  - **S-M2** — token count was unbounded. `q`'s 64-character cap admits 32
    single-character tokens, each emitting its own ANDed pair of `LIKE`
    predicates: 64 evaluations per scanned row on a conjunction that matches
    nothing, so `LIMIT` never short-circuits the scan. Capped at
    `MAX_QUERY_TOKENS = 6`.

  The infix gate is **script-aware** (`hasScanworthyToken`). A minimum-length
  gate is a proxy for a minimum-selectivity gate, and character count is only a
  good proxy inside one alphabet: two Han characters pick a name out of a very
  large space where two Latin letters barely narrow anything. Tokens in Han,
  Hiragana, Katakana or Hangul therefore clear the gate at two characters. This
  was a regression the token-length fix above introduced — `"日本 太郎"` is a
  complete name whose every token is two characters, and a flat three-character
  rule made it unsearchable.

  No change to the response shape of either search surface.

## 0.5.0

### Minor Changes

- 2a98413: Share the search primitives, and make internal handle search an index seek.

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
    normaliser tested `startsWith("@")` _before_ trimming, so `" @alice"` (a paste,
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

## 0.4.1

### Patch Changes

- 8226487: Refresh dependencies across the monorepo (routine maintenance audit).

  Security-relevant: `@simplewebauthn/server` 13.3.0 → 13.3.2 closes
  GHSA-6hxq-p678-4hr2 (CVSS v4 Low 2.0), where a maliciously-crafted attestation
  `x5c` could present a self-signed "root certificate" rather than chaining to an
  RP-specified trust anchor. Reached through `verifyRegistrationResponse()` on the
  passkey registration path. Exposure was nil rather than merely limited: we
  configure no trust anchors anywhere, so `validateCertificatePath` short-circuits
  on `trustAnchorsPEM.length === 0` and no chain decision was ever made — in
  13.3.0 as much as in 13.3.2. Tracked as S-L102, which also records why
  `attestationType: "none"` is _not_ the control here.

  `jose` moves 6.2.3 → 6.2.4 only, which is a docs update plus an `exportJWK`
  refactor that drops `undefined`-valued properties. That change is inert for us:
  `exportKeyToJwk` immediately `JSON.stringify`s its result, and `thumbprintKid`
  feeds RFC 7638 canonicalisation over `kty`/`crv`/`x`/`y`, so existing `kid`s and
  stored JWKs are byte-identical. The JOSE input-validation hardening (Base64URL
  alphabet, UTF-8 in headers and claims, truncated ASN.1 key data, duplicate
  `crit`) is in **6.2.5**, which this branch does _not_ take — it published
  2026-07-29 and is inside the 3-day quarantine. That upgrade is tracked
  separately and matters, since `jose` sits under both ARC S2S tokens and the
  5-minute `osn-access` JWTs.

  `effect` 3.21.2 → 3.22.0 (deprecates `Graph.neighborsDirected`, unused here),
  with `@effect/vitest` 0.29 → 0.30 and `@effect/opentelemetry` 0.63 → 0.64
  following its `^3.22.0` peer. `@effect/platform` is now an explicit
  `@shared/observability` dependency at `^0.97.0`: it was previously auto-installed
  at 0.94.5 purely to satisfy `@effect/opentelemetry`'s peer and did not actually
  meet it.

  `oxlint` 1.70 → 1.76 makes `vitest/expect-expect` effective inside `it.effect`
  bodies for the first time — the rule was already configured with
  `additionalTestBlockFunctions`, but earlier versions never walked those blocks.
  Ten `@osn/api` tests (of 644) were relying on "the Effect didn't fail" as their
  only assertion; each now asserts the behaviour its name claims, with no change
  to what is under test.

  The `@opentelemetry/*` SDK packages are held at `~2.9.0` rather than moved to
  2.10.0. The exporters and `sdk-logs` cannot follow yet — 0.221.0 is inside the
  14-day minor window — and the 0.220.0 exporters pin `core`/`resources`/
  `sdk-metrics`/`sdk-trace` to exactly 2.9.0, so taking only the SDK half splits
  the tree across two lines and links 2.10.0 packages against `core@2.9.0`. The
  tilde is deliberate: `^2.9.0` still admits 2.10.0. The whole line moves together
  once the exporters are eligible (2026-08-04).

  The root `esbuild` override rises `^0.27.0` → `^0.28.1`, closing
  GHSA-g7r4-m6w7-qqqr. The override had inverted from protective to harmful:
  wrangler 4.114 pins `esbuild 0.28.1` — the fixed version — and the `^0.27.0`
  floor was clamping the whole tree back down to the vulnerable 0.27.7. astro
  already declares `^0.28.0`, so `^0.28.1` now agrees with both consumers instead
  of fighting either. `bun audit` reports no vulnerabilities.

  `oxfmt` 0.44 → 0.59 spans four breaking formatter changes, but produces no
  output change here: the `fmt` script already excludes CSS, astro and markdown,
  and the `sort_imports` reclassification of subpath imports matches nothing in
  the tree. `bun run fmt` is a no-op on the current sources and `fmt:check` is
  clean. 0.60/0.61 stay out until they clear the 14-day minor window.

  Everything else is a patch/minor bugfix bump with no migration steps.

## 0.4.0

### Minor Changes

- 43a88ae: Fix two compare-and-swap gates that read the wrong rows-affected field on D1 —
  refresh rotation and passkey rename both failed on every production call.

  Drizzle reports rows affected differently per driver: bun:sqlite and
  better-sqlite3 use `{ changes }`, libsql uses `{ rowsAffected }`, and Cloudflare
  D1 uses `{ success, meta: { changes }, results }`. Both call sites read
  `changes ?? rowsAffected ?? 0`. Tests run on bun:sqlite and production runs on
  D1, so the gates were green in CI and read 0 for every write in production.

  - **Refresh rotation** (`services/auth/tokens.ts`). The old-session `DELETE` is
    the CAS; 0 rows means "a concurrent grant won the race". Reading 0 every time
    meant every production refresh deleted the session it was renewing, skipped
    the replacement INSERT, and answered `400 invalid_grant`. Access tokens live
    five minutes, so every session died at the first refresh — the long-standing
    "logged out for no reason" report. Prod backs this up: no session row has ever
    had `last_used_at` move past `created_at`.
  - **Passkey rename** (`services/auth/passkey-management.ts`). Same read, so a
    rename that updated the row still answered "Passkey not found".

  Both now go through `rowsChanged` from `@shared/db-utils`, which knows all
  three shapes. `cire/api` carried three copies of the same helper — one per
  service — so the fix lands in the one place every package already reaches for
  Drizzle helpers, and the copies are gone. Regression tests drive each osn gate
  through a driver proxy that reports counts D1-style, and unit tests in
  `@shared/db-utils` cover every shape plus junk input.

## 0.3.1

### Patch Changes

- 5aa1594: osn-api runs on Cloudflare Workers (`export default { fetch, scheduled }`).

  `osn/api/src/index.ts` is now the workerd entry, mirroring cire's proven
  template: a per-isolate `cached` app, fail-closed 503 on missing
  bindings/vars, everything built from the request-scoped `env` binding (not
  module-top `process.env`), and a cron `scheduled` handler that runs the
  account-erasure fan-out-retry + hard-delete sweeps (replacing the Bun
  `setInterval`). The Bun dev server moved into `src/local.ts` and is unchanged
  in behavior (default `bun run dev`); a runtime-agnostic `src/build-deps.ts`
  holds the shared composition both entries call.

  Highlights:

  - S-L1: the Workers Redis path env-gates the in-memory fallback — a deployed
    Worker (`OSN_ENV` set & != "local") with missing Upstash bindings fails
    closed at construction instead of silently downgrading rate-limiters /
    step-up-jti to per-isolate in-memory.
  - P-I3: the Upstash client + Effect runtime + Elysia app are built once per
    isolate and cached, never reconstructed in the request path.
  - S-H3: the Workers entry re-applies the `x-request-id` sanitize-and-echo the
    omitted observability plugin used to do.
  - Secrets (`INTERNAL_SERVICE_SECRET`, `PULSE_API_URL`/`ZAP_API_URL`) are
    threaded through `env`/the `createApp` factory instead of module-top
    `process.env` reads, since workerd surfaces secrets only on `env`.
  - `createApp` gains an `aot` flag (Workers passes `false`; AOT's `new
Function` is forbidden on workerd) and keeps `includeObservabilityPlugin:
false` + the redacting `osnLoggerLayer` on the Workers path.

  `@osn/db` / `@shared/db-utils`: `DbLive`'s bun:sqlite path is resolved lazily
  (`makeDbLive` now accepts a path thunk) so `fileURLToPath(import.meta.url)` no
  longer runs at module load — it threw on workerd, where `import.meta.url` is
  undefined, even though the Workers path never builds the bun:sqlite layer.

  wrangler.toml gains `main`, the real per-env D1 ids, per-env `[vars]`, and a
  6-hourly `[triggers] crons` for the sweeper. New devloop scripts: `dev`
  (unchanged fast Bun loop), `dev:wrangler` (workerd + local D1 + in-memory
  Redis, no external services), `deploy`, `types`, `build`.

## 0.3.0

### Minor Changes

- f466a65: Add a four-environment database story (local / dev / staging / prod) and
  migrate Zap onto it. `local` keeps bun:sqlite (fast, free, in-memory unit
  tests + dev); `dev` / `staging` / `prod` run on Cloudflare D1 via Workers.

  `@shared/db-utils` gains a driver-agnostic `Db<S>` type (broadened over
  bun:sqlite's sync and D1's async result kinds), a `createD1Db` /
  `makeD1DbLive` pair mirroring `makeDbLive`, and a `dbQuery` sync/async
  bridge. `makeDbLive` now accepts both the broadened and the existing
  bun:sqlite-only tag shapes.

  `@zap/api` is refactored into a `createApp({ dbLayer, jwtSecret })` factory
  (`aot: false`): `local.ts` runs it on Bun.serve + bun:sqlite, `index.ts` is
  a Workers entry that builds the app over `makeDbD1Live(env.DB)`. Adds
  `wrangler.toml` with `dev` / `staging` / `production` D1 bindings and a
  Miniflare-backed integration test (`bun run test:d1`) covering the async D1
  driver path. `@zap/db` adds a schema-reflection `./testing` export and its
  first generated D1 migration.

## 0.2.3

### Patch Changes

- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

## 0.2.2

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.1

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

## 0.2.0

### Minor Changes

- 880e762: Add `@utils/db` package (`packages/utils-db`) with shared database utilities — `createDrizzleClient` and `makeDbLive` — eliminating boilerplate duplication between `@osn/db` and `@pulse/db`. Both db packages now delegate client creation and Layer setup to `@utils/db`. Also removes the unused singleton `client.ts` export from both db packages.
