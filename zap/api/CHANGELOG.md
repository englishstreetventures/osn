# @zap/api

## 0.9.6

### Patch Changes

- Updated dependencies [d287d72]
  - @shared/crypto@0.13.0
  - @shared/observability@0.15.0
  - @shared/osn-auth-client@0.4.25

## 0.9.5

### Patch Changes

- 13d8ee3: Separate OSN, the system, from Musubi, our implementation of it.

  OSN is now the headless core — identity, the social graph, authorisation and
  the OpenID Connect issuer — with no user interface, runnable by anyone for
  their own private social graph. Musubi is our implementation and the product
  built on it: the social app, its marketing site, the brand, and the
  `musubi.social` instance we host.

  `@osn/social` becomes `@musubi/social` and `@osn/landing` becomes
  `@musubi/landing`, both moving to a new top-level `musubi/` workspace
  directory. The backend packages, `@osn/ui`, the shared packages and every
  wire-level identifier — the `osn-access` and `osn-step-up` token audiences,
  `/.well-known/jwks.json`, claim names, the pairwise subject derivation and the
  ARC token format — keep the OSN name, because an independent implementation has
  to match them to interoperate. That is the rule the split now runs on: if
  another implementation must use the same string, it is OSN; otherwise it is
  Musubi.

  The remaining packages change only in the references they carry. Two of them
  were resolving the moved package by filesystem path rather than by package name
  — `tools/lab/src/lab.css` and `tools/metrics/src/metrics.css` both `@import`
  the social app's stylesheet — and would have failed to build without the
  update.

  Two repository guards learned about the new directory: `fmt` and `fmt:check`
  hardcode the list of workspace directories oxfmt walks, and
  `scripts/validate-changesets.sh` builds its known-workspace-name set from a
  hardcoded `find`. Neither would have reported anything unusual; the format
  check would simply have stopped covering two packages.

  Cloudflare Pages project names (`osn-social`, `osn-social-dev`, `osn-landing`)
  are deliberately unchanged — renaming a Pages project attached to a live apex
  is a deploy operation, not a rename.

## 0.9.4

### Patch Changes

- Updated dependencies [3447d5b]
  - @shared/crypto@0.12.0
  - @shared/osn-auth-client@0.4.24

## 0.9.3

### Patch Changes

- b2b6b70: Clean up the `house/no-tracker-ref-in-comment` mechanical majority (xchromo/osn#924).

  Every finding-tag, phase-code, and narrative-phrase reference flagged by the rule in a short comment block is now gone from these packages: a bare parenthetical tag deleted, a leading label stripped and the remainder capitalized into its own sentence, or a "used to be" narration rewritten forward to state the current, still-true fact. No behavior changes anywhere — every edit is comment text.

  A handful of leftover `osn-tracker#N` citations that predated both this batch and the separate tracker-number-refs cleanup (xchromo/osn#930) are also gone from `@osn/api` and `@pulse/api`, using the same treatment established there.

- Updated dependencies [b2b6b70]
  - @shared/crypto@0.11.3
  - @shared/observability@0.14.3
  - @shared/osn-auth-client@0.4.23

## 0.9.2

### Patch Changes

- Updated dependencies [b78deb7]
  - @shared/observability@0.14.2
  - @shared/crypto@0.11.2
  - @shared/osn-auth-client@0.4.22

## 0.9.1

### Patch Changes

- Updated dependencies [6474854]
  - @shared/crypto@0.11.1
  - @shared/db-utils@0.7.1
  - @shared/observability@0.14.1
  - @shared/osn-auth-client@0.4.21
  - @zap/db@0.6.1

## 0.9.0

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

- d3af349: Apply the Effect v4 combinator renames and the Cause/Runtime rework.

  Renames resolved from upstream's generated reference: `catchAllDefect` →
  `catchDefect`, `catchAllCause` → `catchCause`, `catchAll` → `catch`, `either` →
  `result`, `forkDaemon` → `forkDetach`, `zipRight` → `andThen`, `dieMessage` →
  `die(new Error(…))`, `Layer.scoped` → `Layer.effect`, `Cause.failureOption` →
  `Cause.findErrorOption`. The `Either` module became `Result`, whose variants are
  tagged `Success`/`Failure` and carry `success`/`failure` rather than
  `right`/`left`.

  `Runtime.isFiberFailure` and `FiberFailureCauseId` are gone: v4's runner rejects
  with `Cause.squash(cause)`, which is the typed failure itself, so the two
  osn-api error-shaping helpers no longer unwrap anything. That changes one thing
  on a security path — `Cause.squash` surfaces a _defect_ where v3's
  `Cause.failureOption` returned `None` — and both helpers now document it.

  Adds a test asserting the Redis layer's finalizer runs on scope close. The
  `Layer.scoped` → `Layer.effect` rewrite would have leaked connections silently
  if the scope had been dropped: it type-checks either way, and nothing covered it.

  Second phase of the Effect v4 migration; the tree does not type-check until the
  `Schema` work lands.

- d3af349: Rebuild the logger for Effect v4, and fix a secret leak in annotation redaction.

  `redact()` matches the deny-list against an object's **keys**, and the v3 logger
  mapped over each annotation **value** — so it only ever saw a bare scalar with no
  key attached and passed it through. `Effect.annotateLogs({ accessToken })`
  reached the sink in clear, along with every other deny-listed key, on every tier.
  The record is now passed whole.

  v4 moved annotations off the logger's `Options` and onto the fiber, so redaction
  moves to the output side, wrapping `Logger.formatStructured`. `Logger.layer`
  replaces the whole active set, so `Logger.tracerLogger` is listed explicitly —
  omitting it drops log-to-span correlation silently. `LogLevel` is now string
  literals (`"Warn"`, not v3's `"Warning"`), and the minimum level is a
  `References.MinimumLogLevel` service rather than `Logger.minimumLogLevel`.

  Adds `PrettyLoggerLive` for the dev-server entrypoints, replacing v3's
  `Logger.pretty`. It exists as one export rather than eleven inline
  `Logger.layer([…])` arrays so `tracerLogger` has a single place to be got right.

  Local output loses ANSI colour for an indented structured rendering:
  `consolePretty` is opaque, so there is no seam to redact through it, and one
  redaction point covering every tier is the better trade.

  **The JSON severity field is now `level`, not `logLevel`.** Grafana queries,
  panels and alerts filtering on the old name match nothing and must be updated in
  Grafana Cloud by hand.

- d3af349: Migrate the Effect Schema surface of the four service packages to v4.

  v3's constraint combinators are v4 _checks_, applied through a schema's
  `.check(...)` rather than `.pipe(...)`: `maxLength`/`minLength`/`minItems`/
  `maxItems` collapse onto `isMaxLength`/`isMinLength`, `int` becomes `isInt`, and
  `between(a, b)` becomes `isBetween({ minimum, maximum })` — still inclusive at
  both ends, so no range moved. `Schema.filter` becomes
  `Schema.check(Schema.makeFilter(…))`, and because a v4 filter carries its own
  failure message in its return value, the `{ message: () => "…" }` option becomes
  the predicate returning that string; every validator keeps its exact wording.
  `Schema.Literal` takes a single literal, so enums (and the spreads over
  `SUPPORTED_CURRENCIES`, `SHARE_SOURCES` and `INTEREST_CATEGORIES`) become
  `Schema.Literals([…])`. `Schema.decodeUnknown` becomes
  `Schema.decodeUnknownEffect`, and `Schema.Record` takes its key and value
  positionally.

  Three copies of a workaround are deleted rather than ported. `@pulse/api`'s
  events, series and discovery services each carried a hand-rolled "validate the
  string, then transform to a Date" pair because v3's `DateFromString` accepted a
  string that parses to an Invalid Date. v4's rejects it, so all three are now
  `Schema.DateFromString`.

  `@osn/client`'s `isAuthExpiredError` keeps all three of its arms, but the
  comments no longer claim a `FiberFailure` is what arrives: v4 removed the
  wrapper and `runPromise` rejects with the squashed error itself, so `instanceof`
  now carries the common path. The printout arm stays for a consumer bundle built
  against v3, and for any boundary that strips both the prototype and the `_tag`.

  Every migrated check was verified to still _reject_, not merely type-check.

- d3af349: Drop five `Logger` imports left dead by the v4 logger rework, and finish the
  Effect v4 migration: with `@cire/api` moved off v3 in the same change, the
  whole monorepo type-checks and passes its tests under Effect v4.

  The observability change is the test-only one: `Logger.layer` replaces the
  whole active logger set, so the default logger that used to emit a separate
  "Fiber terminated…" stack dump is gone, and a capture is now exactly the
  entry under test.

- d3af349: Redact the pretty logger, stop a deployed Worker from using it, and stop
  `redact` from killing the fiber that logged.

  `layer.ts` claimed `Logger.consolePretty()` was "opaque, so there is no seam to
  redact through", and the v4 migration gave up ANSI colour on the `local` tier on
  that basis. The claim was false. v4 exposes the entry on the **input** side:
  `Logger.Options` carries `message`, and the pretty logger reads annotations as
  `fiber.getRef(References.CurrentLogAnnotations)`. Shadowing both and delegating
  to an untouched `consolePretty` redacts it while Effect keeps ownership of
  colour, log spans, `LogToStderr`, `ConsoleRef` and the fiber id.

  So `PrettyLoggerLive` is redacted now, and `local` gets colour back — the
  colour-for-redaction trade was never a real trade. The unredacted-logger
  category is gone from the codebase entirely, which is the point: no call site
  can pick the wrong one.

  `redact` gained an `Error` branch returning a real `Error` with scrubbed own
  properties, so the stack traces the pretty logger exists for survive the scrub.
  Nothing changes on the JSON path, where `formatStructured` has already flattened
  values before `redact` sees them.

  `redact` also no longer **throws** on cyclic input; it returns `[Circular]`. It
  runs inside the logger on every deployed tier, so `Effect.logError("x", err)`
  with a looping `cause` chain was killing the fiber that logged. A logger must
  not be able to do that. The primitive fast path is untouched.

  `zap/api/src/index.ts` is a deployed Worker (`main = "src/index.ts"`, route
  `zap.cireweddings.com`) and was the only non-dev-server consumer of
  `PrettyLoggerLive` — so its two registration log lines had no redaction, no
  minimum log level, no span correlation, and emitted multi-line ANSI into Workers
  Logs, which is exactly what the `dev` tier is denied the pretty logger for. It
  now builds `makeLoggerLayer` from the workerd-safe subpaths, memoised per
  isolate. No secret was reaching those lines today — all four reachable throw
  sites in `registerWithOsnApi` are benign — the problem was the shape.

  shared/observability: 92 -> 101. zap/api: 179, unchanged.

- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
  - @zap/db@0.6.0
  - @shared/crypto@0.11.0
  - @shared/db-utils@0.7.0
  - @shared/observability@0.14.0
  - @shared/osn-auth-client@0.4.20

## 0.8.37

### Patch Changes

- Updated dependencies [8fca0c0]
  - @shared/observability@0.13.8
  - @shared/crypto@0.10.18
  - @shared/osn-auth-client@0.4.19

## 0.8.36

### Patch Changes

- Updated dependencies [613c916]
  - @shared/db-utils@0.6.6
  - @zap/db@0.5.14
  - @shared/crypto@0.10.17
  - @shared/osn-auth-client@0.4.18

## 0.8.35

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

- Updated dependencies [0312c9e]
- Updated dependencies [d96da64]
- Updated dependencies [01437b3]
- Updated dependencies [00ed19f]
  - @shared/db-utils@0.6.5
  - @zap/db@0.5.13
  - @shared/crypto@0.10.16
  - @shared/observability@0.13.7
  - @shared/osn-auth-client@0.4.17
  - @shared/rate-limit@0.3.3

## 0.8.34

### Patch Changes

- 853367f: Take jose 6.2.10 (from 6.2.4). Releases 6.2.5 through 6.2.10 are all JOSE and JWT input-validation hardening: reject characters outside the Base64URL alphabet, reject invalid UTF-8 in JOSE headers and JWT claims sets, reject truncated ASN.1 key data, reject duplicate `crit` values, reject an unencoded payload in the JWS Compact Serialization, compare claim values correctly for falsy validation options, and enforce verification key metadata from a JWKS. jose sits under both the ARC service-to-service tokens and the five-minute osn-access JWTs, so this is parser hardening on the two token types where it matters most. No API change; the tightening only narrows what parses.
- Updated dependencies [853367f]
  - @shared/crypto@0.10.15
  - @shared/osn-auth-client@0.4.16

## 0.8.33

### Patch Changes

- 981ea54: Move every remaining colocated test file into its package's `tests/` tree, the
  layout `wiki/conventions/testing-patterns.md` has documented all along.

  `osn/landing` and `pulse/landing` kept their suites beside the source in `src/`
  (and `pulse/landing` a third under `functions/`); those now mirror `src/` under
  `tests/`. The three API packages' Miniflare-backed D1 suites move from
  `src/d1-integration.test.ts` to `tests/d1/d1-integration.test.ts` — they used to
  sit outside the vitest `include` glob by accident of living in `src/`, and are
  now excluded from it explicitly by path, so `bun run test:d1` stays the only
  thing that runs them. `tsconfig.json` gains `tests/**/*` wherever the tests were
  previously type-checked only because they lived under `src/`.

  No test bodies changed; only their location and the relative paths inside them.

  - @shared/crypto@0.10.14
  - @shared/osn-auth-client@0.4.15

## 0.8.32

### Patch Changes

- 350c4d7: Fold Zap's per-chat write and membership paths from several round trips into one.

  `sendMessage`, `listMessages` and `sendC2bMessage` each used to run a `SELECT`
  for the chat row and then a separate `assertMember` query for membership,
  paying two round trips before doing anything. All three now run a single
  `LEFT JOIN` between `chats` and `chat_members` scoped to the caller's
  `profileId`, reading chat existence and membership off one row (`memberId ===
null` is the new non-member signal, in place of `assertMember`'s empty
  result set).

  `createChat`, `provisionC2bChat` and `sendC2bMessage` batch their multi-row
  writes (`commitBatch` from `@shared/db-utils`) instead of several sequential
  `Effect.tryPromise` awaits — atomic on D1's `db.batch`, sequential-but-safe on
  bun:sqlite. Member-row inserts are chunked at `MAX_MEMBER_ROWS_PER_INSERT` (20
  rows/statement, new in `zap/api/src/lib/limits.ts`) to stay under D1's
  ~100-bound-parameter ceiling per query on a chat created at the
  `MAX_CHAT_MEMBERS` (500) cap.

  `addMember`'s cap-plus-duplicate check is folded into one query
  (`count()` + a conditional `sum()` over `chat_members`, in place of a
  `COUNT(*)` followed by a separate indexed duplicate lookup), and the
  remaining concurrent-duplicate-add race — two adds of the same profile
  both passing the check before either inserts — is closed by catching the
  database's own unique-constraint failure on the follow-up INSERT and
  resolving it to `AlreadyMember` (409) instead of `DatabaseError` (500). The
  bounded `.cause`-chain walk this needs (`isUniqueConstraintFailure`, exported
  for its own unit tests) accounts for D1 wrapping every failure in
  `DrizzleQueryError` where bun:sqlite does not.

  `createChat` and `provisionC2bChat` now cap `memberProfileIds` at
  `MAX_CHAT_MEMBERS` — previously unbounded on `createChat`, so a caller could
  build a batched INSERT arbitrarily larger than D1 can execute in one
  invocation.

  The ARC-gated DSAR account-export route (`POST /internal/account-export`)
  gains an explicit cap: `profile_ids` over `MAX_EXPORT_PROFILE_IDS` (100, new
  limit) now returns 400 rather than letting the loaders' `IN (...)` clauses
  grow past D1's bound-parameter ceiling. Its c2b-message loader
  (`loadC2bMessages`) also replaces a two-query pair — c2b chat ids for the
  profiles, then messages by `inArray(messages.chatId, c2bChatIds)`, the second
  query's `IN` list unbounded in parameters — with a single three-table join
  scoped only by `profileIds`, and groups by `messages.id` rather than using
  `DISTINCT`: the join can duplicate a message row when two exported profiles
  share a chat, and the projection (`chatId`, `body`, `createdAt`) deliberately
  carries no `messages.id`, so a naive `DISTINCT` on the projected columns would
  collapse two genuinely different messages that share a body and the same
  second-resolution `createdAt` into one row and silently drop a message from a
  data subject's export.

  - @shared/crypto@0.10.13
  - @shared/osn-auth-client@0.4.14

## 0.8.31

### Patch Changes

- Updated dependencies [5c51a23]
  - @zap/db@0.5.12
  - @shared/crypto@0.10.12
  - @shared/osn-auth-client@0.4.13

## 0.8.30

### Patch Changes

- Updated dependencies [965c2ee]
  - @shared/observability@0.13.6
  - @shared/crypto@0.10.11
  - @shared/osn-auth-client@0.4.12

## 0.8.29

### Patch Changes

- 673ca2b: Enforce the chat class on every public chat operation, and finish the returned-row conversion.

  Four public operations never checked `chats.class`. `sendMessage` let a member of a `c2b` (consumer-to-business) chat write an encrypted message into it; `listMessages` served that chat's plaintext `body` column straight back, going round the ARC-gated reader that is supposed to be the only way to it; `removeMember` let a member leave a chat cire had authorised, which silently truncated their own DSAR export, because the export reaches c2b message bodies only through `chat_members`; and `updateChat`/`addMember` were closed to c2b chats only by accident, since such a chat has no admin for `assertAdmin` to reject. A `c2b` chat is defined as server-visible, moderatable and DSAR-exportable; a ciphertext row inside one is none of those — the account export filters on a non-null `body` so the row is dropped silently, and the internal reader renders it as an empty string with no signal that content was withheld. All of them now fail `NotC2cChat`, reported as 409, mirroring the check `sendC2bMessage` already made the other way round. On the two public message routes the class check runs _after_ the membership check — unlike its ARC-gated counterpart, because answering "not a c2c chat" to a stranger holding a chat id would tell them which ids are commercial.

  `addMember` and `updateChat` were the last two write paths still re-reading the row they had just written. They now return what they wrote, through `storedNow()` — and `updateChat` keeps the stored title when a request sends none, which is what Drizzle's omit-undefined `SET` does and what the read-back used to get right by accident.

  `zap/db`'s DDL lockstep test now also checks `drizzle/meta/`: `drizzle-kit generate` reads the journal and the latest snapshot rather than the `.sql` files, so a journal that has lost an entry makes the next generate re-emit a migration already applied to production.

- Updated dependencies [673ca2b]
  - @zap/db@0.5.11

## 0.8.28

### Patch Changes

- e382c40: Enforce the access-token `issuer` claim in every downstream verifier.

  `@shared/osn-auth-client` has always accepted an expected `iss`, but every consumer left it unset — deliberately, because a verifier that pins the issuer rejects every token minted before osn-api started stamping one, and the rollout had to be verifier-first. Access tokens live five minutes, so that window closed long ago: every live token carries `iss`, and leaving the check off means a token from any other OSN deployment verifies here as long as it is signed by a key that deployment's JWKS vouches for.

  `cire/api`, `pulse/api` and `zap/api` now pass the expected issuer on every `extractClaims` call. In pulse and zap the JWKS URL and the issuer travel as one `OsnTokenVerification` value rather than two loose strings, so a call site cannot supply one and silently forget the other — which is the failure mode that left this unenforced, since an unset expected issuer is not an error, it is simply no check.

  `OSN_ISSUER_URL` is now required in a deployed tier and must equal osn-api's own value byte for byte; a mismatch 401s every authenticated request, so the two flip in the same deploy. `zap/api` gains the var, which it did not read before. `@shared/crypto/testing`'s signer stamps the local issuer by default, so a suite that injects a test key mints tokens its routes accept; pass a different origin, or `null`, to exercise the rejection paths.

  Three things fell out of reviewing it. `extractClaims` now treats an expected issuer that is present but **empty** as a configuration failure rather than as "no issuer check" — an unset env var reaching the verifier was the one way this could look configured while checking nothing. The comparison normalises a trailing slash on both sides, since six hand-maintained `wrangler.toml` values feed it and `jose` compares byte for byte. And `zap/api` gains `OSN_ISSUER_URL`/`OSN_JWKS_URL` in the portless devloop, which it never had — every bearer-authenticated zap route was 401ing locally, and pinning the issuer is what made that visible.

- Updated dependencies [e382c40]
  - @shared/crypto@0.10.10
  - @shared/osn-auth-client@0.4.11

## 0.8.27

### Patch Changes

- 5d8417f: Drop a wasted read after every chat and message write, and stop `listC2bMessages` silently restarting at page 1 on an unknown cursor.

  The four write paths (`createChat`, `provisionC2bChat`, `sendMessage`, `sendC2bMessage`) re-read the row they had just inserted before returning it. Every column was already known, so that was one more sequential D1 round-trip per write for nothing — three to four on the enquiry hot path. They now return the values they wrote. Timestamps go through a new `storedNow()` helper because Drizzle stores `timestamp` columns as whole seconds: an untruncated `Date` would make a write's response disagree with every later read of the same row by up to 999ms.

  Both list paths now page with a composite `(createdAt, id)` keyset instead of a strict `createdAt <`. Second-resolution timestamps are not unique, so the old cursor silently skipped every message sharing the cursor's second — unreachable for ever once the page moved past it. `messages_chat_created_idx` gains `id` so the ordering stays index-satisfied. Within one second the display order is now unspecified rather than incidentally insertion-ordered; the fix for that needs millisecond storage and is tracked separately.

  `listC2bMessages` now fails with a validation error on a `before` cursor it cannot find, matching `listMessages`; the route answers 400 rather than 200-with-page-1, which used to send a paginating caller round the same page for ever. `chats_class_idx` is dropped — `EXPLAIN QUERY PLAN` gives an identical plan with and without it, so it was write amplification only.

- Updated dependencies [5d8417f]
  - @zap/db@0.5.10

## 0.8.26

### Patch Changes

- @zap/db@0.5.9
- @shared/crypto@0.10.9
- @shared/osn-auth-client@0.4.10

## 0.8.25

### Patch Changes

- Updated dependencies [8fac137]
  - @shared/crypto@0.10.8
  - @shared/osn-auth-client@0.4.9

## 0.8.24

### Patch Changes

- Updated dependencies [ee304e6]
  - @shared/osn-auth-client@0.4.8

## 0.8.23

### Patch Changes

- ee195a3: Add missing test coverage: the UNIQUE-constraint conflict branch in
  `completeEmailChange`, and route-level 401 coverage for an expired bearer
  access token on a protected Pulse and Zap route.

## 0.8.22

### Patch Changes

- Updated dependencies [b219759]
  - @shared/osn-auth-client@0.4.7
  - @zap/db@0.5.8
  - @shared/crypto@0.10.7

## 0.8.21

### Patch Changes

- Updated dependencies [7a75d6c]
  - @shared/crypto@0.10.6
  - @shared/osn-auth-client@0.4.6

## 0.8.20

### Patch Changes

- fe3ee5d: Run the devloop behind portless: named HTTPS hosts instead of ports, and one stack per worktree.

  Every app's `dev` script is now `portless`, which reads that package's own `"portless"` key and runs its real command (`dev:app`) behind the proxy. `@osn/api` answers on `https://id.musubi.localhost`, `@pulse/web` on `https://pulse.localhost`, and so on — twelve port numbers nobody has to remember, and no clash when two things want 4321. The names mirror production hostnames.

  The nesting under a shared parent is load-bearing rather than cosmetic. A WebAuthn RP ID has to be the origin's host or a registrable suffix of it, so passkeys created on `@osn/social` are only verifiable by `@osn/api` if both sit under one parent: `musubi.localhost` and `id.musubi.localhost`, RP ID `musubi.localhost`. Flat names would have put every local passkey out of reach of the API that checks it.

  In a linked worktree portless prepends the branch, so `bun run dev` in two worktrees gives two complete, independent stacks. That is also why no app can be told where its siblings live from a committed `.env` — the answer differs per worktree. The new `@shared/dev-urls` package derives it instead: its `dev-env` launcher fronts each `dev:app`, reads the app's own `PORTLESS_URL`, splits off the shared worktree prefix and TLD, and rebuilds every sibling's origin from them. It exports the same env vars the deployed tiers set (`OSN_ISSUER_URL`, `OSN_RP_ID`, `OSN_ORIGIN`, `PULSE_CORS_ORIGIN`, `PUBLIC_API_URL`, …), so no app source knows portless exists.

  Two posture changes worth naming. `OSN_RP_ID` was the bare `localhost`, which every app on the machine shares; it is now `musubi.localhost`, so a local passkey is scoped to the account family — existing `localhost` passkeys will not resolve and need re-enrolling. And `DEV_LOGIN_RETURN_ORIGINS`, which the Bun devloop left unset (closed: every `return_to` a 400), now carries the same four frontend origins `wrangler.toml` already set for `wrangler dev`. The route still only mounts when `DEV_LOGIN_SECRET` is set.

  `PORTLESS=0 bun run dev` still gives the old fixed-port devloop. The ports the frontends lost from their `dev` scripts moved into their configs behind `devPort()`, which prefers the `PORT` portless assigns and falls back to the old literal, so the bypass keeps working and the four Astro apps do not all land on 4321.

## 0.8.19

### Patch Changes

- Updated dependencies [2440ea9]
  - @shared/crypto@0.10.5
  - @shared/osn-auth-client@0.4.5

## 0.8.18

### Patch Changes

- Updated dependencies [60e9c51]
  - @shared/observability@0.13.5
  - @shared/crypto@0.10.4
  - @shared/osn-auth-client@0.4.4

## 0.8.17

### Patch Changes

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

- Updated dependencies [d4553ed]
- Updated dependencies [587f561]
- Updated dependencies [c87ea88]
- Updated dependencies [9f1b272]
- Updated dependencies [1ddf9bb]
  - @shared/observability@0.13.4
  - @shared/osn-auth-client@0.4.3
  - @shared/crypto@0.10.3
  - @zap/db@0.5.7

## 0.8.16

### Patch Changes

- Updated dependencies [d50c68e]
  - @shared/crypto@0.10.2
  - @shared/observability@0.13.3
  - @shared/rate-limit@0.3.2
  - @shared/osn-auth-client@0.4.2

## 0.8.15

### Patch Changes

- Updated dependencies [2e8e8ba]
  - @shared/observability@0.13.2
  - @shared/crypto@0.10.1
  - @shared/osn-auth-client@0.4.1

## 0.8.14

### Patch Changes

- Updated dependencies [1c19bae]
  - @shared/osn-auth-client@0.4.0
  - @shared/crypto@0.10.0

## 0.8.13

### Patch Changes

- @zap/db@0.5.6
- @shared/crypto@0.9.5
- @shared/osn-auth-client@0.3.5

## 0.8.12

### Patch Changes

- 4d5f815: Fix two silent DDL-emitter defects and consolidate test harnesses

  The schema-reflection emitters in `@osn/db/testing`, `@pulse/db/testing` and
  `@zap/db/testing` dropped two kinds of constraint when building test databases:

  - **Column-level `UNIQUE`.** `emitColumn()` read only the table config's
    `uniqueConstraints` (table-level `unique()`), never `col.isUnique`, where
    Drizzle records column-level `.unique()`. Seven OSN constraints were dropped —
    `accounts.email`, `accounts.passkey_user_id`, `users.handle`,
    `passkeys.credential_id`, `recovery_codes.code_hash`, `organisations.handle`,
    `oauth_clients.client_id`.
  - **Partial-index `WHERE` clauses.** Four OSN partial indexes were emitted as
    full indexes, and `deletion_jobs`' pulse/zap pending pair collapsed into a
    single duplicate.

  The blast radius was narrower than it first appears, and worth stating
  precisely: `osn/api`'s unit lane used a hand-written DDL block that already
  carried all seven UNIQUEs, so replacing it with `applySchema()` is drift-proofing
  rather than new coverage. The lane that genuinely ran without them is the
  Miniflare D1 in `osn/api/src/d1-integration.test.ts`, which builds from
  `createSchemaSql()` directly — the only test proving OSN core runs on real D1 was
  doing so against a schema that accepted duplicates and had four indexes widened.

  `osn/db/tests/ddl-lockstep.test.ts` (new) diffs a normalised structural
  snapshot of the emitted schema against the full `osn/db/drizzle/*.sql`
  migration chain — columns, defaults, indexes (including column order within an
  index), partial predicates, foreign keys and their referential actions — and
  fails on any divergence. `zap/db` gets the same test. Both emitter fixes are
  applied to all three copies; pulse and zap were unaffected in practice (neither
  schema uses column-level `.unique()` or partial indexes today) but carried the
  same latent trap.

  The emitter also now emits `ON DELETE`/`ON UPDATE` actions, which it previously
  dropped — harmless while every OSN foreign key is `no action`, but the first
  `onDelete: "cascade"` would otherwise have cascaded in production and restricted
  in every test.

  Two performance fixes to the emitters, both measured: the reflected DDL is
  memoised (it was ~24% of per-test database setup, recomputed for a schema that
  cannot change within a process) and the `SQLiteSyncDialect` is hoisted out of
  the per-index loop.

  Also in this change:

  - `osn/db/tests/schema.test.ts` builds its fixture with `applySchema()` instead
    of a hand-written `CREATE TABLE` block. Its three "enforces unique …
    constraint" tests previously asserted against DDL typed in the same file, so
    removing every `.unique()` from `osn/db/src/schema` left all 50 tests green;
    they now fail as intended.
  - `osn/api/tests/helpers/db.ts` drops 239 lines of hand-maintained DDL for the
    same `applySchema()` call.
  - New `@shared/crypto/testing` export with `makeAccessTokenSigner()`, replacing
    the duplicated ES256 key-pair + `makeToken` block in 12 pulse/zap route
    suites; `@cire/api`'s `makeOsnTestAuth()` becomes a thin adapter over it.
  - `pulse/api/tests/services/rsvps.test.ts` — the test named "upsertRsvp ensures
    pulse_users row is created" asserted `expect(true).toBe(true)`; it now queries
    `pulse_users`.
  - `zap/api/src/d1-integration.test.ts` — repaired a stale fixture that had been
    failing unnoticed: it created a DM as a bare `{ type: "dm" }`, predating the
    Z3 "a DM is exactly two people" guard and the Z4 consent gate. Nothing caught
    it because the D1 integration lane runs outside the default vitest include and
    no CI workflow invokes `test:d1` — tracked as T-C1 in `wiki/TODO.md`.

- Updated dependencies [4d5f815]
  - @shared/crypto@0.9.4
  - @zap/db@0.5.5
  - @shared/osn-auth-client@0.3.4

## 0.8.11

### Patch Changes

- @zap/db@0.5.4
- @shared/crypto@0.9.3
- @shared/osn-auth-client@0.3.3

## 0.8.10

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

- Updated dependencies [8226487]
  - @shared/crypto@0.9.2
  - @shared/observability@0.13.1
  - @shared/osn-auth-client@0.3.2
  - @shared/rate-limit@0.3.1
  - @zap/db@0.5.3

## 0.8.9

### Patch Changes

- @shared/crypto@0.9.1
- @shared/osn-auth-client@0.3.1

## 0.8.8

### Patch Changes

- Updated dependencies [2b7a7f1]
  - @shared/osn-auth-client@0.3.0
  - @shared/crypto@0.9.0

## 0.8.7

### Patch Changes

- @zap/db@0.5.2
- @shared/crypto@0.8.11
- @shared/osn-auth-client@0.2.11

## 0.8.6

### Patch Changes

- Updated dependencies [0953024]
  - @shared/observability@0.13.0
  - @shared/crypto@0.8.10
  - @shared/osn-auth-client@0.2.10

## 0.8.5

### Patch Changes

- Updated dependencies [307a2c1]
  - @shared/observability@0.12.3
  - @shared/crypto@0.8.9
  - @shared/osn-auth-client@0.2.9

## 0.8.4

### Patch Changes

- Updated dependencies [f57a201]
  - @shared/observability@0.12.2
  - @shared/crypto@0.8.8
  - @shared/osn-auth-client@0.2.8

## 0.8.3

### Patch Changes

- Updated dependencies [f951187]
  - @shared/observability@0.12.1
  - @shared/crypto@0.8.7
  - @shared/osn-auth-client@0.2.7

## 0.8.2

### Patch Changes

- f45323d: Add the `nodejs_compat_populate_process_env` compatibility flag so `process.env.INTERNAL_SERVICE_SECRET` resolves in production (zap-api's `compatibility_date` predates the 2025-04-01 auto-populate cutoff). Fixes the `/internal/register-service` endpoint returning 501 "Service registration is disabled" and zap-api's own outbound ARC registration silently skipping — both of which read the secret via `process.env`.

## 0.8.1

### Patch Changes

- a10d4bb: Make zap-api actually deployable to Cloudflare Workers (first prod bring-up). Fix two workerd-hostile module-load patterns: `zap/db/src/service.ts` now passes the bun:sqlite path as a thunk so `fileURLToPath(import.meta.url)` is deferred into the lazy Layer (never runs on workerd, where `import.meta.url` is undefined at deploy-eval); `zapGraphBridge.ts` resolves + https-validates `OSN_API_URL` lazily (at call time) instead of at module load (workerd `[vars]` populate `process.env` only at runtime). Adds the `zap.cireweddings.com` custom-domain route + `OSN_API_URL` prod var to `zap/api/wrangler.toml`.
- Updated dependencies [a10d4bb]
  - @zap/db@0.5.1

## 0.8.0

### Minor Changes

- bce0fe4: Add a server-visible c2b (consumer-to-business) chat class to Zap: `chats.class`, plaintext `messages.body`, ARC-gated `/internal/chats` provisioning + message CRUD (scope `chat:c2b`), and c2b bodies in the DSAR export. Adds a dormant `deploy-zap-api` CI job (activates once the prod D1 is provisioned).

### Patch Changes

- Updated dependencies [bce0fe4]
  - @zap/db@0.5.0

## 0.7.1

### Patch Changes

- Updated dependencies [f569c7c]
- Updated dependencies [f569c7c]
  - @shared/crypto@0.8.6
  - @shared/osn-auth-client@0.2.6

## 0.7.0

### Minor Changes

- 6b14961: C-H1 — account data export (`GET /account/export`, DSAR Art. 15 / 20 + CCPA).

  Self-service, step-up gated (new `account_export` step-up purpose), rate-limited
  to 1 export / 24 h / account. Streams the locked NDJSON bundle
  (`{"version":1,...}` header → `{"section","record"}` lines → `{"end":true}`
  terminator) via a `ReadableStream`, so the response never materialises the full
  dataset. osn's own sections (account, profiles, passkeys, sessions,
  security_events, recovery_codes counts, email_changes, connections, blocks,
  organisations) are read with keyset pagination (`LIMIT 500 WHERE id > :cursor`,
  no OFFSET). The internal `accountId` is never emitted (P6 invariant).

  The `pulse.*` / `zap.*` sections are fetched over ARC (new `account:export`
  scope, registered downstream alongside `account:erase`) from a new
  `POST /internal/account-export` on each app and streamed through the outer
  envelope line-by-line; a failing bridge degrades to a `{"degraded":...}` line
  rather than breaking the stream. Pulse returns rsvps / events-hosted /
  close-friends; Zap returns chat memberships only (message ciphertext excluded).

  Also builds Zap's inbound-ARC infrastructure from scratch (it previously had
  none): `zap/api` gains an `arc-middleware` (`requireArc` + key registry +
  `register-service` bootstrap) mirroring Pulse's, closing the latent gap where
  osn's cross-service fan-out targeted a Zap `/internal` surface that did not
  exist.

  `@shared/observability` adds the `account_export` value to the `StepUpPurpose`
  metric-attribute union.

### Patch Changes

- Updated dependencies [6b14961]
  - @shared/observability@0.12.0
  - @shared/crypto@0.8.5
  - @shared/osn-auth-client@0.2.5

## 0.6.6

### Patch Changes

- Updated dependencies [630e98f]
  - @shared/crypto@0.8.4
  - @shared/observability@0.11.2
  - @shared/osn-auth-client@0.2.4

## 0.6.5

### Patch Changes

- f62784d: Code-quality sweep: lint-config repair + convention fixes monorepo-wide.

  - oxlint config: pin rules that leaked in via an upstream category re-shuffle
    (`no-underscore-dangle` off — Effect `_tag` is idiomatic;
    `unicorn/consistent-function-scoping` off — boot-time factory modules and
    Effect-context DI make it noise; `no-await-in-loop` off in tests), raise
    `jsx-a11y/control-has-associated-label` depth for Solid control-flow
    wrappers. 463 → 21 warnings; the survivors are the deliberate aspirational
    jsx-a11y set.
  - S-M5 (osn): `/account` erasure endpoints now thread `clientIpConfig` +
    socket peer into per-IP rate-limit keying (spoofable XFF no longer picks
    the bucket; unresolved IPs are denied, S-M34 posture) — with route tests.
  - pulse/api + zap/api route factories now build their Effect layer graph once
    per factory via `ManagedRuntime` instead of `Effect.provide(dbLayer)` inside
    every request (convention: `osn/api/src/lib/route-runtime.ts`); dead
    pre-instantiated route-group exports removed.
  - Dead exports removed: `decodeSession` (@osn/client), `getHandleFromToken`
    (@pulse/app).
  - Assorted lint fixes: variable shadowing renames, unused imports, promise
    handling in `TurnstileWidget`, `toSorted` in tests.

## 0.6.4

### Patch Changes

- 368e3e8: Performance audit sweep (versioned packages). No behavioural or security
  changes — fail-closed rate limiting, visibility gates, consent checks,
  single-use guarantees, and tenant scoping are preserved exactly.

  - `@zap/api`: `listChats` is cursor-paginated (default 50, max 100) with a
    composite `(createdAt, id)` keyset cursor (same-second creation bursts are
    never skipped) and caller-scoped cursors (unknown/foreign cursors
    rejected); `getChatMembers` is limit/offset-paginated (default 100, max 500) and skips its redundant existence load when the route has already
    asserted membership; both list responses carry `hasMore` (+ `nextCursor`
    for chats) continuation metadata; `addMember` checks the member cap with
    `COUNT(*)` instead of fetching every member row.
  - `@osn/api`: ceremony-store TTL sweep debounced to once per 30s (hard cap
    still enforced on every set); `beginRegistration`/`registerProfile`
    uniqueness probes collapsed to one round-trip via `UNION ALL` of two
    indexed single-table arms (an `OR` across the users-accounts join defeats
    SQLite's OR-optimization and plans as a full table scan);
    `sendConnectionRequest` reads run concurrently; `consumeRecoveryCode` is a
    single atomic conditional `UPDATE … RETURNING` (also closes the remaining
    check-then-act window); `countActiveRecoveryCodes` is a SQL aggregate that
    no longer fetches `code_hash` values; redundant accounts read moved out of
    the identified passkey-login path; per-call `TextEncoder` allocation and
    per-issuance `process.env` reads hoisted to module scope.
  - `@pulse/api`: status-transition persistence batched to one `UPDATE … WHERE
id IN (…)` per (from → to) group across all five list surfaces (was up to
    500 writes per GET on series instances); `updateSeries`/`cancelSeries`
    collapsed to single race-free `UPDATE … RETURNING`; `listTodayEvents`
    capped at 200 rows; RSVP routes thread the already-loaded event row into
    `listRsvps`/`rsvpCounts`/`latestRsvps`; `createEvent` uses `INSERT …
RETURNING`; `GET /events/:id/ics` sends `Cache-Control: private,
no-cache` + a weak ETag and honours `If-None-Match` (including `*` and
    multi-value lists) with 304 — every reuse revalidates through the
    visibility gate.
  - `@pulse/db`: new `event_rsvps_event_status_idx (event_id, status)`
    composite index; the subsumed single-column `event_rsvps_event_idx` is
    dropped (migration 0008).
  - `@osn/client`: `RegistrationClient.checkHandle` accepts an optional
    `AbortSignal` so debounced callers can cancel stale availability probes.
  - `@osn/ui`: `Register` and `CreateProfileForm` abort the previous in-flight
    handle check before issuing a new one and on unmount.
  - `@pulse/app`: Explore map resize handling is debounced (100 ms), grid
    geometry is memoized per size, and theme detection is a reactive
    `MutationObserver`-driven signal instead of a per-access DOM read.

## 0.6.3

### Patch Changes

- Updated dependencies [f4b9c6b]
  - @zap/db@0.4.2
  - @shared/crypto@0.8.3
  - @shared/osn-auth-client@0.2.3

## 0.6.2

### Patch Changes

- Updated dependencies [5d6a97c]
  - @shared/observability@0.11.1
  - @shared/crypto@0.8.2
  - @shared/osn-auth-client@0.2.2

## 0.6.1

### Patch Changes

- @shared/crypto@0.8.1
- @shared/osn-auth-client@0.2.1

## 0.6.0

### Minor Changes

- 5055e1a: Harden Zap auth and authorization.

  W1 (token verification): replace the HS256 shared-secret JWT check with
  ES256/JWKS verification via `@shared/osn-auth-client` (audience `osn-access`,
  inline per-handler). `OSN_JWT_SECRET` is gone. A single chokepoint
  (AUDIT-Z2) rejects any verified `sub` that is not a `usr_` id so a non-user
  principal can never be written into `created_by_profile_id` /
  `sender_profile_id`. Boot fails fast if the JWKS URL is plaintext HTTP in a
  non-local environment.

  W2 (authorization & consent): pulling a profile into a chat now requires a
  permitted OSN social-graph relationship, checked over an ARC-authenticated
  Zap to OSN bridge (`/graph/internal/connection-status`, scope `graph:read`)
  and failing closed (reject + `blocked` denial metric) when the graph is
  unreachable. DMs are pinned to exactly two members; the last admin of a chat
  can no longer be removed; message-list cursors are scoped to their chat and
  unknown cursors are rejected instead of silently returning page 1. CORS is
  restricted to a known-origin allowlist (`ZAP_CORS_ORIGIN`, fail-closed in
  non-local envs) instead of reflecting any origin.

  NOTE: requires `zap-api` to be provisioned as an ARC issuer in the OSN
  `service_accounts` table (allowed scope `graph:read`); in local dev this is
  done via self-registration with `INTERNAL_SERVICE_SECRET`.

### Patch Changes

- Updated dependencies [5055e1a]
- Updated dependencies [dbed689]
- Updated dependencies [130e6c5]
- Updated dependencies [5055e1a]
- Updated dependencies [5e4c560]
- Updated dependencies [5055e1a]
  - @shared/observability@0.11.0
  - @shared/rate-limit@0.3.0
  - @shared/osn-auth-client@0.2.0
  - @shared/crypto@0.8.0
  - @zap/db@0.4.1

## 0.5.0

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

### Patch Changes

- Updated dependencies [f466a65]
  - @zap/db@0.4.0

## 0.4.6

### Patch Changes

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

- Updated dependencies [d04dc20]
- Updated dependencies [77f91a4]
- Updated dependencies [04e0bf2]
  - @shared/observability@0.10.1
  - @zap/db@0.3.2
  - @shared/rate-limit@0.2.2

## 0.4.5

### Patch Changes

- Updated dependencies [c3cca40]
  - @shared/observability@0.10.0

## 0.4.4

### Patch Changes

- Updated dependencies [9f6874b]
  - @shared/observability@0.9.2

## 0.4.3

### Patch Changes

- Updated dependencies [073238d]
  - @shared/observability@0.9.1

## 0.4.2

### Patch Changes

- Updated dependencies [9de67a2]
  - @shared/observability@0.9.0

## 0.4.1

### Patch Changes

- Updated dependencies [ac7312b]
  - @shared/observability@0.8.1

## 0.4.0

### Minor Changes

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

### Patch Changes

- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @zap/db@0.3.1
  - @shared/observability@0.8.0
  - @shared/rate-limit@0.2.1

## 0.3.19

### Patch Changes

- Updated dependencies [6387b98]
  - @shared/observability@0.7.0

## 0.3.18

### Patch Changes

- Updated dependencies [b1d5980]
  - @shared/observability@0.6.1

## 0.3.17

### Patch Changes

- Updated dependencies [c04163d]
  - @shared/observability@0.6.0

## 0.3.16

### Patch Changes

- Updated dependencies [811eda4]
  - @shared/observability@0.5.2

## 0.3.15

### Patch Changes

- Updated dependencies [58e3e12]
  - @shared/observability@0.5.1

## 0.3.14

### Patch Changes

- Updated dependencies [dc8c384]
  - @shared/observability@0.5.0

## 0.3.13

### Patch Changes

- Updated dependencies [9459f5e]
  - @shared/observability@0.4.0

## 0.3.12

### Patch Changes

- Updated dependencies [2d5cce9]
  - @shared/observability@0.3.3

## 0.3.11

### Patch Changes

- Updated dependencies [2a7eb82]
  - @shared/observability@0.3.2

## 0.3.10

### Patch Changes

- Updated dependencies [0edef32]
  - @shared/observability@0.3.1

## 0.3.9

### Patch Changes

- 1d9be5a: Extract `createRateLimiter`, `getClientIp`, and `RateLimiterBackend` into a new `@shared/rate-limit` package. `@zap/api` now imports directly from `@shared/rate-limit` and no longer depends on `@osn/core`.
- Updated dependencies [1d9be5a]
  - @shared/rate-limit@0.2.0

## 0.3.8

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/core@0.17.0

## 0.3.7

### Patch Changes

- Updated dependencies [d691034]
  - @osn/core@0.16.4

## 0.3.6

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @shared/observability@0.3.0
  - @osn/core@0.16.3

## 0.3.5

### Patch Changes

- Updated dependencies [42589e2]
  - @shared/observability@0.2.10
  - @osn/core@0.16.2

## 0.3.4

### Patch Changes

- Updated dependencies [a723923]
  - @osn/core@0.16.1
  - @shared/observability@0.2.9

## 0.3.3

### Patch Changes

- Updated dependencies [8137051]
  - @osn/core@0.16.0
  - @shared/observability@0.2.8

## 0.3.2

### Patch Changes

- Updated dependencies [33e6513]
  - @osn/core@0.15.0
  - @shared/observability@0.2.7

## 0.3.1

### Patch Changes

- Updated dependencies [5520d90]
  - @osn/core@0.14.1

## 0.3.0

### Minor Changes

- f5c1780: feat: add multi-account schema foundation (accounts table, userId → profileId rename)

  Introduces the `accounts` table as the authentication principal (login entity) and renames
  `userId` to `profileId` across all packages to establish the many-profiles-per-account model.

  Key changes:

  - New `accounts` table with `id`, `email`, `maxProfiles`
  - `users` table gains `accountId` (FK → accounts) and `isDefault` fields
  - `passkeys` re-parented from users to accounts (`accountId` FK)
  - All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
  - Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
  - Registration flow creates account + first profile atomically

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/core@0.14.0
  - @zap/db@0.3.0
  - @shared/observability@0.2.6

## 0.2.2

### Patch Changes

- Updated dependencies [e2ef57b]
  - @osn/core@0.13.0
  - @shared/observability@0.2.5

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/core@0.12.1
  - @shared/observability@0.2.4
  - @zap/db@0.2.1

## 0.2.0

### Minor Changes

- 7349512: Add Zap messaging backend with chat and message services for event chat integration

  - Create `@zap/db` package with chats, chat_members, and messages schema (Drizzle + SQLite)
  - Create `@zap/api` package with Elysia server (port 3002), chat/message REST routes, Effect services, and observability metrics
  - Add `chatId` column to Pulse events schema for event-chat linking
  - Add `zapBridge` service in Pulse for provisioning event chats and managing membership

### Patch Changes

- Updated dependencies [7349512]
  - @zap/db@0.2.0
