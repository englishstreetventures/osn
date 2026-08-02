# @utils/db

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
