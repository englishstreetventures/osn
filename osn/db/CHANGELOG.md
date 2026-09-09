# @osn/db

## 0.24.0

### Minor Changes

- 46023fa: Gate passkey deletion and email change on credential provenance, not on wall clock alone

  A passkey registered a minute ago under an emailed code minted a step-up token indistinguishable from one the user had held for a year, so the narrow allow-lists on `passkey_delete` and `email_change` constrained only the direct path. Registering a credential and asserting it reached both gates in two hops.

  `passkeys.provenance_amr` now records the effective strength of the ceremony chain behind each credential, inherited so the pivot cannot be laundered by another hop, and `accounts.last_recovered_at` opens a 72-hour window after any recovery. A credential that predates the recovery acts immediately; one the recovery produced waits. Adds `POST /recovery/disown`, the single-use "this wasn't me" lever carried by the recovery notice, which revokes the credentials that recovery enrolled, every session on the account, and the window itself.

  The disown route answers the same `202` on every branch a caller without the token can reach, and a `500` on one they cannot: a database failure after the token has matched. That branch is the difference between the lever having fired and not, so it is reported rather than hidden, and the token is put back for a second attempt. A token reaches only the recovery it was minted for — a later recovery keeps its own credentials and its own window.

## 0.23.0

### Minor Changes

- 2aedc02: The `osn-recovery` token audience, for restricted recovery sessions

  Account recovery has to end in a session that can enrol a fresh passkey and do
  nothing else. This adds that primitive. **No route mints one yet** — the
  recovery endpoints are separate work, and the tests are this change's reader.

  The restriction is a distinct access-token audience, `osn-recovery`, not a
  column. There is no single guard a column could be checked in: four entry points
  in osn-api verify access tokens, and `pulse/api`, `zap/api` and `cire/api` verify
  the same token over JWKS with no access to OSN's database. All seven already pin
  `osn-access`, so all seven reject the new audience with **no change to any of
  them** — fail-closed by construction, and not waiting on three other services to
  deploy. `resolvePasskeyEnrollPrincipal` is the only resolver taught to accept it,
  which makes `/passkey/register/begin` and `/complete` the only two routes it
  reaches.

  `sessions.restricted_until` (new column, migration `0008`) is the source of truth
  for **rotation**, not for request-time authorisation: `refreshTokens` copies it
  forward and re-mints on the recovery audience, or the restriction would die on
  the first silent refresh five minutes in. It also pins an absolute 15-minute
  expiry that never slides — and that guard has to be explicit, because a
  restricted session's whole life sits inside half of a 30-day TTL, so the sliding
  window's own condition is always true for exactly the session that must expire on
  schedule. `completePasskeyRegistration` clears the column and restores an
  ordinary TTL, which is what lifts the restriction.

  A recovery-audience caller **bypasses the passkey step-up gate**, deliberately:
  losing a phone does not delete its passkey row, so the gate would otherwise block
  the common recovery case. The alternative — letting a restricted session mint
  step-up tokens — would hand it `/recovery/generate`, `DELETE /account`,
  `GET /account/export` and `/account/email/complete` as well.

  That bypass is the one grant of privilege here, and it is priced rather than
  assumed. `issueRecoverySession` takes a **required** `amr` — `"otp"`, `"totp"` or
  `"webauthn"` — refuses at mint time anything `passkeyRegisterAllowedAmr` does not
  admit, and records it in `sessions.restricted_amr` (new column, migration
  `0009`), which rotation carries forward alongside the deadline.
  `beginPasskeyRegistration` reads that column back off the caller's own session
  row, so its `caller` argument is now the session's hash
  (`{ recoverySessionHash }`) rather than a boolean the route asserted from the
  token's audience: no route can mint a session whose factor the gate would have
  refused, and narrowing the allow-list withdraws the bypass from sessions already
  issued.

  Two predicates were added to the write that lifts the restriction, which is the
  one place a restricted session becomes a full one. It is now scoped to the
  caller's `account_id`, like the two sibling session writes that take the same
  server-derived hash, and to `expires_at > now` — `liveSessionIds` has no expiry
  term, so an expired restricted row still classified as the caller's own and
  enrolment converted it into an ordinary 30-day session, making the real bound the
  15-minute deadline plus one access-token TTL rather than 15 minutes.

  Two behaviour changes beyond the issue, both closing ways the restriction would
  have failed open:

  - `verifyRefreshToken` now **rejects a restricted session unless the caller opts
    in**, and `refreshTokens` is the only caller that does. `GET /authorize`
    resolves the signed-in user from the session cookie rather than an access
    token, so without this a recovery session would have completed an OIDC
    authorization and signed the user into every relying party.
  - `ACCESS_TOKEN_AUDIENCE` moves into `constants.ts` beside the new one, and the
    reserved OIDC client-id deny-list references both by name instead of repeating
    the literals — the deny-list can no longer drift from the audiences it guards.

## 0.22.0

### Minor Changes

- d287d72: TOTP enrolment, verification and disable on osn-api

  An account can now enrol an authenticator app, use it to satisfy a step-up
  ceremony, and remove it. TOTP is a step-up factor only — it is not a login
  factor, and passkeys remain the sole primary one.

  The shared secret is the one credential in the schema that cannot be hashed,
  because RFC 6238 verification needs the raw HMAC key back. It is AES-256-GCM
  encrypted under a new `OSN_TOTP_ENCRYPTION_KEY` Worker secret, with the account
  id as additional authenticated data. **osn-api refuses to boot in a deployed
  tier without that secret**, so it has to be provisioned before this ships;
  local dev generates an ephemeral key, exactly as the JWT signing pair does.
  That key **cannot be rotated**: rows carry a `key_version` and the service holds
  exactly one key, so installing a new one makes every enrolled credential
  unverifiable. The column is there so adding rotation later needs no migration.

  `verifyTotpCode` in `@shared/crypto/totp` now returns the step it matched
  (`{ step } | null`) rather than a boolean. RFC 6238 §5.2 single use is not
  enforceable without it, and the alternative — refusing every code for the rest
  of the drift window after a success — would fail a legitimate second ceremony
  ninety seconds later. Breaking, and free: nothing outside its own test consumed
  it.

  Also: a `totp` AMR value, `totp_enroll` and `totp_disable` step-up purposes,
  `totp_enrolled` / `totp_disabled` security events and notification emails, five
  new rate-limiter slots, a `TotpClient` in `@osn/client`, and a `totp` section in
  the DSAR export.

  `passkeyDeleteAllowedAmr` stays WebAuthn-only and the email-change gate keeps an
  allow-list of its own, so neither admits a `totp` AMR **directly**. Neither is a
  boundary against a TOTP seed, and neither was one before this branch: any factor
  those gates' sibling `passkeyRegisterAllowedAmr` admits can register a passkey
  and assert it, arriving with the `webauthn` AMR both lists accept. Closing that
  needs credential provenance and is tracked separately.

## 0.21.2

### Patch Changes

- b2b6b70: Clean up the `house/no-tracker-ref-in-comment` mechanical majority (xchromo/osn#924).

  Every finding-tag, phase-code, and narrative-phrase reference flagged by the rule in a short comment block is now gone from these packages: a bare parenthetical tag deleted, a leading label stripped and the remainder capitalized into its own sentence, or a "used to be" narration rewritten forward to state the current, still-true fact. No behavior changes anywhere — every edit is comment text.

  A handful of leftover `osn-tracker#N` citations that predated both this batch and the separate tracker-number-refs cleanup (xchromo/osn#930) are also gone from `@osn/api` and `@pulse/api`, using the same treatment established there.

## 0.21.1

### Patch Changes

- Updated dependencies [6474854]
  - @shared/db-utils@0.7.1

## 0.21.0

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

- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
  - @shared/db-utils@0.7.0

## 0.20.13

### Patch Changes

- Updated dependencies [613c916]
  - @shared/db-utils@0.6.6

## 0.20.12

### Patch Changes

- 0312c9e: Take @cloudflare/workers-types 5.20260830.1 (from 4.20260702.1). This also fixes a peer range nobody had noticed: wrangler 4.127.1 declares an optional peer on `@cloudflare/workers-types` `^5.20260722.1`, which the old `^4.20260702.1` pin did not satisfy. Types only, no runtime change.
- d96da64: Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges.

  `fast-uri` 3.1.5 → 3.1.7. Four high advisories against 3.1.5 landed on 2026-09-02 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — two SSRF, two host confusion) and the pre-push `bun audit` gate went red. Taking 3.1.6, which is what those four advisories name as fixed, would have left two more: 3.1.7 also fixes GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port in `serialize()`) and GHSA-58mr-gqgx-xq4g (host confusion via unbalanced IP-literal brackets), neither of which is in the public advisory database yet, so no audit tool reports them. Reachability is the Astro language server only — `ajv` appears once in the lockfile, under `@astrojs/check`, and no deployed Worker or shipped bundle contains it. `smol-toml` 1.6.1 → 1.8.0 is the same shape: 1.7.1 carries the fix for GHSA-7w5x-hrqm-74c2, also absent from the database.

  The rest is lockfile lag. The dependency sweep in this stack raised every declared range, but `bun.lock` stayed behind versions those ranges already admitted: `esbuild` 0.28.2, `postcss` 8.5.26, `picomatch` 4.0.7, `sharp` 0.35.4 (libvips 1.3.3), `js-yaml` 4.3.2, `ws` 8.21.3, `devalue` 5.9.2, `happy-dom` 20.12.2, `@cloudflare/workers-types` 5.20260903.1. Two are worth knowing about rather than just taking: `ws` 8.21.1 **lowers the `maxBufferedChunks` and `maxFragments` defaults** and counts empty fragments toward the limit, which is a behaviour change inside a patch and touches Zap's WebSocket surface; `picomatch` 4.0.5–4.0.7 are all matching-semantics fixes, so glob-driven config can shift.

  `astro` 7.2.9 → 7.2.10 is the one with deployed consequences. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. It is pinned to 7.2.10 rather than left to float: 7.3.0 and 7.3.1 clear the three-day soak but not the fourteen-day rule for a minor, so they wait.

  Two overrides were correcting themselves in the wrong direction and are fixed here. `undici` was pinned `^7.29.0` while `jsdom` 30 declares `undici ^8.9.0` and `unifont` 0.7.5 declares `^8.0.0` — a floor being used as a ceiling, holding both consumers a whole major below what they were written for and cutting the tree off from undici 8 security fixes. Raised to `^8.9.0` (resolves 8.10.1). Because top-level `miniflare` 4 pins undici at exactly 7.28.0 and the wrangler-nested miniflare 5 alpha pins 7.29.0, this was verified rather than assumed: type check, the full test suite, the Miniflare D1 tier, all four Worker builds, and a real `wrangler dev --local` boot of `osn-api` on workerd, which serves 200 on `/health`, `/.well-known/jwks.json` and `/` with no errors. `postcss` and `picomatch` were likewise below what `vite` 8.2.2 asks for (`^8.5.26` and `^4.0.5`), a floor gap opened by raising vite earlier in this stack.

  Also: the `protobufjs` override matched nothing in the lockfile and is removed, and `bunfig.toml`'s note on the removed `fast-uri` soak exclusion claimed the package "parses URIs on the request path via ajv", which is not true of this tree and would have mispriced exactly the decision this changeset had to make.

  One source change, in `cire/api/tests/index.test.ts`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` a required member of `Span`, so the test's `StubSpan` gains it, typed off the interface rather than restated so the next daily types release cannot drift it.

- 01437b3: Take better-sqlite3 13.0.3 (from 12.11.1) and @types/better-sqlite3 9.6.0 (from 7.6.13). Nothing in `src/` imports either — the real consumer is drizzle-kit, which resolves better-sqlite3 dynamically to back `db:migrate`, `db:push`, `db:studio` and `db:reset`. Verified by running `drizzle-kit generate` against 13.0.3 in all three packages. The two packages move together because the type definitions had drifted two majors behind the runtime.
- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

- Updated dependencies [0312c9e]
- Updated dependencies [d96da64]
- Updated dependencies [00ed19f]
  - @shared/db-utils@0.6.5

## 0.20.11

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

## 0.20.10

### Patch Changes

- e38d6de: Email change and registration now correctly tell a real database fault apart from a genuine duplicate-address conflict, and a rate-capped account can no longer learn whether an email address is taken by watching which check fails first.

## 0.20.9

### Patch Changes

- 5c51a23: Enforce foreign keys on `bun:sqlite`, and fix the two erasure bugs that were hiding behind it.

  SQLite defaults `PRAGMA foreign_keys` to **OFF** while D1 enforces them, so every local run and every test accepted writes production rejects. The cheap, fast environment was the permissive one, which is the worst way round: a statement that orphans a row, or deletes a parent before its children, passed the whole suite and would have failed on deploy.

  Turning it on found `hardDeleteAccount` broken in two ways, both of which would make GDPR Art. 17 erasure throw rather than complete. It deletes the `accounts` row while deliberately keeping `security_events` and `email_changes` under Art. 6(1)(c) — but both declared a foreign key to `accounts`, so a column documented to outlive its parent referenced it. Those two constraints are dropped. It also deleted `users` before the `oauth_consents` and `oauth_authorization_codes` rows that carry a `profile_id` referencing them; those deletes now run first.

  `dev-login`'s provisioning batch declared itself infallible through `Effect.promise` while being a chain of inserts that reference rows an earlier `onConflictDoNothing` may have skipped. With foreign keys on, that arrived as a defect and escaped the route's own error handling, answering 400 where the contract says 500 `provisioning_failed`.

- Updated dependencies [5c51a23]
  - @shared/db-utils@0.6.4

## 0.20.8

### Patch Changes

- Updated dependencies [518bc7d]
  - @shared/db-utils@0.6.3

## 0.20.7

### Patch Changes

- Updated dependencies [b219759]
  - @shared/db-utils@0.6.2

## 0.20.6

### Patch Changes

- Updated dependencies [d4553ed]
- Updated dependencies [9f1b272]
- Updated dependencies [1ddf9bb]
  - @shared/db-utils@0.6.1

## 0.20.5

### Patch Changes

- 2e8e8ba: Deploy OSN identity to its own dev tier, isolated from production.

  The cire dev tier needs an identity provider it can break. `[env.dev]` in
  `osn/api/wrangler.toml` was a set of localhost placeholders pointing at the
  production `osn-db`; it is now a real deployed tier — route
  `id.dev.musubi.social` (`custom_domain = true`), `OSN_RP_ID = "dev.musubi.social"`,
  its own issuer and authorize-UI URLs, the `osn-db-dev` D1 database, five native
  rate-limit namespaces on fresh ids, and its own `[env.dev.triggers]`. Dev
  passkeys are separate credentials from production, which is the point.

  Same `process.env` fix as `@cire/api`: this Worker also pins
  `compatibility_date = "2025-03-01"` without
  `nodejs_compat_populate_process_env`, so `loadConfig` resolved the `local` tier
  in production and the logger picked the local format and level. The flag is
  listed explicitly and the module-top-level read moves to request scope —
  `process.env` populates lazily on first access, so the flag alone would not have
  fixed a top-level read. The comment in `shared/observability` asserting that
  `nodejs_compat` populates `process.env` was wrong and is corrected.

  `@osn/db` gains the same per-env migrate script shape as the other db packages.

## 0.20.4

### Patch Changes

- Updated dependencies [dea594b]
  - @shared/db-utils@0.6.0

## 0.20.3

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

## 0.20.2

### Patch Changes

- Updated dependencies [2a98413]
  - @shared/db-utils@0.5.0

## 0.20.1

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
  - @shared/db-utils@0.4.1

## 0.20.0

### Minor Changes

- 55a8ea8: Security + UX hardening across the auth stack (review of PRs #315–#324).

  **Identity / OIDC provider (`@osn/api`, `@osn/db`)**

  - Pairwise-`sub` isolation: a self-serve OIDC client's sector is now its
    server-generated `client_id`, not the first redirect-URI host (attacker-chosen
    and unverified), so colluding clients can no longer share a sector to correlate
    the same user across apps.
  - `auth_time` survives silent session rotation: sessions gain an immutable
    `authenticated_at` (new column, copied forward on every refresh), so a relying
    party's `max_age`/`prompt=login` reflects the real passkey ceremony instead of
    the last background token refresh.
  - Consent-screen anti-impersonation: client names are NFKC-normalised, reject
    bidi/zero-width/control characters, and are blocked when they fold to a
    confusable skeleton of a first-party app name (Musubi, OSN, Pulse, Zap, Cire).
  - Step-up tokens are bound to their ceremony purpose at every gate (passkey
    register/delete, email change, security-event ack), closing cross-ceremony
    replay of a still-unconsumed token.
  - Destructive passkey routes fail closed (409) on a presented-but-stale session
    binding instead of degrading to an account-wide session wipe (S-M2).
  - Minor OIDC hardening: generic token-endpoint errors (no internal cause on the
    wire), RFC 9207 `iss` on authorization responses, required browser-binding on
    every parked request (S-L4), a total-rows cap on client registration, and a
    branded HTML error page for pre-validation `/authorize` failures.

  **Client + UI (`@osn/client`, `@osn/ui`, `@osn/social`)**

  - New OIDC connections SDK; Settings → "Connected apps" now lists and revokes
    real connections (GDPR Art. 7(3)) instead of a hardcoded list.
  - The security-events banner is mounted (recovery-code generate/consume events
    now reach the user in-app), and the consent screen surfaces a verifiable
    identity signal (verified-app badge / third-party redirect host).
  - Consent UX: a `login_required` re-auth loop is capped, the profile picker gets
    a decline path, and a trailing-slash `/authorize/` no longer escapes the bare
    layout. CSP tightened (object-src/base-uri/form-action).
  - Recovery codes are guarded against silent loss on navigation after the old set
    is revoked; the rotation warning uses the component-library dialog; the
    step-up dialog explains why re-auth is needed; a failed passkey ceremony maps
    to an actionable recovery message.

## 0.19.1

### Patch Changes

- Updated dependencies [43a88ae]
  - @shared/db-utils@0.4.0

## 0.19.0

### Minor Changes

- 307a2c1: OIDC provider deferred-hardening batch — closes every deferred finding from the PR #315 prep-pr review that didn't genuinely need the consent-screen UI.

  **@osn/api (minor)**

  - **S-H1 (oidc)** — honest `auth_time` + enforced freshness. `verifyRefreshToken` now returns `authenticatedAt` (session `created_at`); codes and ID tokens carry the session's real authentication time instead of the code-mint time. `max_age` is parsed and bounded; exceeding it behaves like `prompt=login`; both park the request with `requireAuthAfter` and `/authorize/decision` refuses (`400 login_required`, request kept alive for retry) any session created before that instant, re-checking `max_age` at decision time.
  - **S-M1 (oidc)** — per-request browser-binding cookie. `/authorize` sets a 600 s HttpOnly `__Host-`-prefixed cookie per parked request; the store keeps only its SHA-256. Context reads without it 404 like an unknown id; decisions without it fail before the request is consumed.
  - **S-M2 (oidc)** — `RESERVED_OIDC_CLIENT_IDS` deny-list enforced at `findClient` (reserved ids read as absent); OIDC access tokens carry a `typ: "at+jwt"` header (RFC 9068) via a new optional `typ` parameter on `signJwt`.
  - **S-M3 / C-M3 (oidc)** — user-facing connections routes: `GET /oidc/connections` (live grants with client name/logo) and `DELETE /oidc/connections/:clientId` (revokes the consent and deletes in-flight authorization codes for the pair — withdrawal is immediate). Two new rate-limiter slots (`oidcConnectionsList` 30/min, `oidcConnectionsRevoke` 10/min) across the in-memory, Redis, and native-binding bundles.
  - **C-M1 (oidc)** — DSAR export gains an `oidc_consents` section (clientId, clientName, profileId, scope, grantedAt, revokedAt; revoked grants included as withdrawal history).
  - **P-W1/2/4/5, P-I3 (oidc)** — exchange and decision return their metric dimensions instead of re-reading the client/parked request; `recordConsent` is insert-first (`ON CONFLICT DO NOTHING`); the two token signatures run concurrently; client/consent reads use explicit projections. P-W3 declined: the `/token` reads are dependency-ordered — consuming the code before client auth would burn a victim's code on an attacker's failed attempt.
  - PKCE `code_challenge` is now required to be exactly 43 base64url characters (an S256 digest's only possible length); discovery advertises `auth_time`, `preferred_username`, `picture`, `email_verified`.
  - Prep-pr review fixes: `prompt=login` records its freshness demand on the signed-out park path too; a re-grant after revocation replaces the stored scope instead of resurrecting withdrawn scopes; the token exchange re-checks consent liveness (revocation is race-free); binding-mismatch errors are byte-identical to unknown-id errors; binding-hash compares are constant-time.

  - **Self-serve client registration** — `POST /oidc/clients` (server-generated `cid_`, secret shown exactly once with only its SHA-256 stored, https-only redirect URIs with loopback-http dev tolerance, no fragments, https-only `logo_url`, derived `sector_identifier`, `is_first_party` never settable, 5-live-clients-per-account cap), `GET /oidc/clients` (owner's list, never the secret), `DELETE /oidc/clients/:clientId` (disable — the client reads as absent everywhere at once). Three new rate-limiter slots (`oidcClientCreate` 5/hour on the hour-window tier, `oidcClientList` 30/min, `oidcClientDisable` 10/min). Account erasure disables and unlinks owned clients; DSAR export gains an `oidc_clients_owned` section.
  - New GitHub workflow `set-osn-pairwise-salt.yml` (`workflow_dispatch`, production environment): sets the `OSN_PAIRWISE_SALT` Worker secret idempotently — generates 64 random bytes in-job, never prints them, and refuses to touch an existing secret (rotation is forbidden by design).

  **@osn/db (minor)**

  - `oauth_clients` gains `owner_account_id` (nullable, references `accounts`) + `oauth_clients_owner_idx` (migration `0003_sleepy_mongoose`) — the self-registration ownership link.

  **@shared/observability (patch)**

  - `AuthRateLimitedEndpoint` widened with `oidc_connections_list`, `oidc_connections_revoke`, `oidc_client_create`, `oidc_client_list`, `oidc_client_disable`.

## 0.18.0

### Minor Changes

- f57a201: Add an OpenID Connect provider to osn-api, so any app can recognise an OSN
  account without holding a passkey of its own.

  Passkeys bind to one domain and cannot be moved, so every product that wants
  its own sign-in either shares the identity domain or asks the user to enrol
  again. This is the way out: the ceremony stays on the identity domain, and
  other apps get there by redirect.

  Three endpoints and a discovery document:

  - `GET /authorize` — authorization code flow, PKCE with S256 only. Errors
    follow RFC 6749 §4.1.2.1: until the client and its redirect URI are both
    known good the error is rendered, never redirected, so the provider cannot
    be turned into an open redirect. `prompt=none|login|select_account|consent`
    all behave as the spec says.
  - `GET /authorize/context` and `POST /authorize/decision` — what the consent
    screen reads and writes. The request id is single use, so an approval
    cannot be replayed into a second code.
  - `POST /oidc/token` — code for tokens. One code, one exchange; the code is
    deleted as it is read. Public clients must present no secret, confidential
    clients may use `client_secret_basic` or the body, never both.

  Subjects are pairwise: each client sees a `sub` derived by HMAC from its own
  sector and the profile, so two clients cannot join their records by user id.
  Codes are stored hashed, as session tokens already are.

  New tables in `@osn/db`: `oauth_clients`, `oauth_authorization_codes`,
  `oauth_consents` (migration `0002_wet_gamora`).

  Four rate limiters and their metric attributes come along with it. Both
  shared packages change only to widen a closed union — no behaviour moves.

  Before the next non-local deploy, set `OSN_PAIRWISE_SALT` (32 bytes or more)
  as a Worker secret. The check is fail closed: without it osn-api will not
  boot outside local. Set `OSN_AUTHORIZE_UI_URL` once the consent screen has a
  home; it falls back to `/authorize` on the web origin.

  See `[[wiki/systems/oidc-provider]]`.

## 0.17.3

### Patch Changes

- 630e98f: TODO-backlog hardening sweep:

  - **S-H (arc-scope-pattern)** — `@shared/crypto` `SCOPE_PATTERN` rejected hyphens, so every ARC token minted with the deployed hyphenated scopes (`step-up:verify`, `app-enrollment:write`) threw `Invalid scope format` at sign time — the Flow B leave-Pulse fan-out was broken end-to-end. Pattern now admits `-`; regression-tested round-trip.
  - **S-H1 (arc-key-scopes, prep-pr review) — mitigation** — osn-api stores `allowedScopes` per SERVICE (upsert = full replace) while pulse-api registers TWO keys under one serviceId; disjoint scope sets clobbered each other on every boot race / 24h rotation, randomly fail-closing either the graph bridge or Flow B. Both pulse registrations (graphBridge + outbound-arc) and the seed now carry the identical four-scope union, and the false "per-key isolation" comment is corrected. Real per-key scope storage is tracked in wiki/TODO.md.
  - **S-L1 (prep-pr review)** — osn-api's `requireArc` early exits (malformed token, unknown/revoked kid, registry scope denial) now record the shared `arc.token.verification` counter, mirroring the pulse receiver; infra (DB-query) failures are excluded from the counter.
  - **S-M1 (pulse-onboarding)** — dedicated `graph:resolve-account` ARC scope gates `GET /graph/internal/profile-account` (least privilege on the profileId → accountId lookup). Granted to pulse-api (self-registration + seed) and cire-api (runbook); a `graph:read`-only token now gets 401 on that endpoint.
  - **S-L6 (account-deletion)** — Pulse `requireArc` now records the shared `arc.token.verification` counter on its early-exit branches (malformed / kid-unknown / kid-revoked / registry-scope-denied); new bounded `revoked_key` result value in `@shared/observability`.
  - **S-M4 (auth)** — `loadJwtKeyPair` asserts the imported `OSN_JWT_PRIVATE_KEY` carries the `sign` usage, failing at boot when the public JWK is pasted into the private slot.
  - **S-L5 (auth)** — boot-time assertion that `OSN_ORIGIN` is set in non-local envs (mirrors the CORS fail-closed guard) instead of silently falling back to the localhost WebAuthn origin.
  - **M3 (Copenhagen)** — `EmailSchema` caps emails at 255 chars.
  - **Dead metric cleanup (pulse)** — `pulse.auth.jwks_cache.lookups` deleted (cache moved to `@shared/osn-auth-client`, uninstrumented); `pulse.events.create.duration` wired around `createEvent` via `withEventCreateDuration`; `pulse.events.host_cancelled.hard_delete` wired into `runEventCancellationSweep`.

## 0.17.2

### Patch Changes

- f4b9c6b: Upgrade oxlint to 1.70; satisfy tightened vitest rules — add toThrow messages and fix standalone-expect in test suites

## 0.17.1

### Patch Changes

- 5add635: Handle prefix search for co-host autocomplete.

  - `@osn/db`: add a B-tree index on `users.handle` (`users_handle_idx`) to back
    left-anchored `LIKE 'prefix%'` scans, with forward-only migration
    `0001_exotic_lady_vermin.sql`. DEPLOY: this migration must be applied to
    osn-db-prod manually at deploy time — it is NOT in CI's `deploy.yml`
    (`bun run --cwd osn/db db:migrate:prod`).
  - `@osn/api`: new ARC-gated `GET /graph/internal/profile-search?prefix=&limit=`
    (scope `graph:read`, audience `osn-api`, same guard as the sibling internal
    endpoints). Normalises the prefix like `profile-by-handle` (strips `@`,
    lowercases), requires a minimum prefix length of 2 (returns an empty list,
    not an error, below it), excludes tombstoned/soft-deleted accounts
    (`deletedAt IS NULL`), escapes `LIKE` wildcards in the user input, orders by
    handle, and hard-caps results at 10 (default 8). Returns
    `{ profiles: [{ id, handle, displayName, avatarUrl }] }`.

## 0.17.0

### Minor Changes

- dd2dad3: Regenerate the osn-db drizzle migration chain into a single clean baseline.

  The previous chain (`0000`–`0009`) had drifted from the live schema during the accounts/users refactor: no migration created the `accounts` table, yet `0003`/`0004`/`0005`/`0006`/`0009` referenced it, so the chain could not apply to a fresh D1 (tests/local had been running off the schema directly, masking the break). The osn D1s are empty and nothing is deployed, so the chain was squashed into a single `0000` baseline generated from `osn/db/src/schema/index.ts`. The baseline applies cleanly from scratch (all 15 tables incl. `accounts`) and `wrangler d1 migrations apply` now works for the osn-db dev/staging/prod databases.

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

- Updated dependencies [5aa1594]
  - @shared/db-utils@0.3.1

## 0.16.0

### Minor Changes

- f466a65: Migrate Pulse and the OSN core DB layer onto the four-environment database story
  (local bun:sqlite / dev·staging·prod D1). D1 has no interactive transaction, so
  every `db.transaction(async tx => …)` is rewritten to the shared `commitBatch`
  helper — an atomic `db.batch([...])` on D1, sequential awaited writes on
  bun:sqlite — preserving all-or-nothing semantics on the deployed driver.

  `@pulse/api`: 5 account-erasure transactions → `commitBatch`; `createApp`
  factory (`aot: false`) + `local.ts` (Bun.serve) + Workers `index.ts` (D1) +
  `wrangler.toml` (dev/staging/production) + a Miniflare integration test.

  `@osn/api`: all 17 transactions across auth / profile / graph / organisation /
  account-erasure → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants
  (UNIQUE-constraint guards for handle/email races; a count-guarded conditional
  DELETE for the last-passkey invariant). Adds a Miniflare integration test and a
  `wrangler.toml` for D1 migration tooling. NOTE: full Workers _hosting_ of
  osn-api remains gated on replacing ioredis with a Workers-compatible Redis —
  its DB layer is D1-ready but it still runs only as the Bun.serve `local` host.

  `@pulse/db` / `@osn/db`: broadened service `Db` type + `makeDbD1Live`,
  schema-reflection `./testing` export, and wrangler-based `db:migrate:*` scripts.

### Patch Changes

- Updated dependencies [f466a65]
  - @shared/db-utils@0.3.0

## 0.15.1

### Patch Changes

- 77f91a4: Local DB dev tooling — `db:reset` across the monorepo:

  - Root `bun run db:reset` resets every app DB; `osn/db`, `pulse/db`, `zap/db`
    each wipe their sqlite file → `db:push` → seed (seed skipped where no seed
    file exists, without swallowing real seed failures).
  - `cire/db` `db:seed` now runs `scripts/cire-db-seed.sh`, which seeds the local
    D1 and re-points the bootstrap wedding owner from `CIRE_DEV_OWNER_PROFILE_ID`
    (dev convenience — migration 0006 seeds the `usr_REPLACE_BEFORE_PROD`
    placeholder); `db:reset` = wipe D1 + push + seed.
  - `cire/db` drizzle.config points `db:studio` at the local miniflare D1 sqlite.
  - `cire/api` local dev server (`local.ts`) re-points the bootstrap wedding owner
    from `CIRE_DEV_OWNER_PROFILE_ID` so the signed-in account owns it (the dev
    server uses an in-memory seeded DB, not the persistent D1).

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

## 0.15.0

### Minor Changes

- c3cca40: Account deletion compliance (C-H2 / GDPR Art. 17).

  Two flows:

  - **Flow A — full OSN account delete.** New `DELETE /account` on osn-api with step-up gate, 7-day soft-delete grace + manual fast-track, ARC fan-out to currently-enrolled apps, hard-delete sweeper.
  - **Flow B — leave Pulse.** New `DELETE /account` on pulse-api with step-up verification round-trip to osn-api. Hosted events flip into a 14-day public cancellation window before hard-delete (audience commitment, independent of the 7-day account grace).

  Schema additions:

  - `osn/db`: `accounts.deleted_at`, `accounts.processing_restricted_at`, new `app_enrollments` (modular-platform opt-in tracking) and `deletion_jobs` (in-flight tombstones with per-bridge `*_done_at`).
  - `pulse/db`: `events.cancelled_at` / `hard_delete_at` / `cancellation_reason`, new `pulse_deletion_jobs`.

  Other surfaces:

  - New step-up token `purpose` claim (`account_delete`, `pulse_app_delete`) — confused-deputy guard for cross-service flows.
  - New osn-api internal endpoints: `/internal/step-up/verify`, `/internal/app-enrollment/{join,leave}`. ARC scopes `step-up:verify`, `app-enrollment:write`, `account:erase` added to the register-service allowlist.
  - Pulse becomes an ARC verifier (in-memory key registry + `/internal/register-service`) and an ARC issuer for the leave-app callback.
  - New observability: `osn.account.deletion.{requested,completed,duration,fanout,fanout_pending_age}`, `osn.account.app_enrollment.{joined,left}`, `pulse.account.deletion.*`, `pulse.events.host_cancelled[.hard_delete]`.
  - New `osn/client` SDK methods: `deleteAccount`, `cancelAccountDeletion`, `getAccountDeletionStatus`.

## 0.14.2

### Patch Changes

- 073238d: Migrate close friends from OSN core to Pulse.

  Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
  app can implement its own close-friends-style list against the OSN connection
  graph; OSN core retains only `connections` and `blocks`.

  What it does in Pulse:

  - **Feed boost.** Events organised by a close friend surface higher in
    `listEvents` (stable partition: chronological order preserved within each
    bucket; not applied for anonymous viewers).
  - **Hosting affordance.** The existing RSVP avatar ring — driven by an
    attendee having marked the viewer as a close friend — is preserved end-to-end,
    now backed by the local `pulse_close_friends` table.
  - **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
    header avatar dropdown).

  Surface changes:

  - New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
    routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
    `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
  - Removed: OSN-core `close_friends` table, services, routes (user-facing
    `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
    graph close-friend SDK methods on `@osn/client`, the close-friends tab in
    `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
    and the `GraphCloseFriendAction` observability attribute.
  - Connection projection now includes `id` so cross-DB references (Pulse adding
    by profile id) work without duplicating handle→id resolution.

  Pre-launch: the OSN `close_friends` table is dropped outright; seed data
  updated. No migration path or backwards-compatibility shims.

## 0.14.1

### Patch Changes

- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
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

- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @shared/db-utils@0.2.3

## 0.14.0

### Minor Changes

- b1d5980: M-PK: passkey-primary prerequisites — passkey management surface + discoverable-credential login.

  **Features**

  - `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (step-up gated) — list, rename, remove credentials from Settings.
  - Discoverable-credential / conditional-UI passkey login. `POST /login/passkey/begin` accepts an empty body and returns `{ options, challengeId }`; clients round-trip the challenge ID to `/login/passkey/complete`.
  - `last_used_at` tracking on every assertion + step-up ceremony (60s coalesce).
  - WebAuthn enrolment tightened to `residentKey: "required"` + `userVerification: "required"`.
  - Hard cap of 10 passkeys per account (P-I10), enforced at both `begin` and `complete`.
  - New `SecurityEventKind` `passkey_delete` — audit row + out-of-band notification, same pattern as recovery-code generate/consume.
  - Last-passkey lockout guard: `DELETE /passkeys/:id` refuses the final credential unless recovery codes exist.
  - New `@osn/client` surface `createPasskeysClient`; `@osn/ui/auth/PasskeysView` settings panel.
  - `SignIn` opportunistically invokes `navigator.credentials.get({ mediation: "conditional" })` on mount when supported.

  **Breaking**

  - Removed the legacy unverified `POST /register` HTTP endpoint — use `/register/begin` + `/register/complete`.
  - `LoginClient.passkeyComplete` now takes `{ identifier | challengeId, assertion }` instead of positional args.
  - `AuthMethod` attribute union dropped `"password"` (OSN is passwordless).

  **DB**

  - Migration `0007_passkey_management.sql` adds `label`, `last_used_at`, `aaguid`, `backup_eligible`, `backup_state`, `updated_at` columns to `passkeys` (all nullable).

  **Observability**

  - New span names `auth.passkey.{list,rename,delete}`.
  - New counter `osn.auth.passkey.operations{action, result}`.
  - New histogram `osn.auth.passkey.duration{action, result}`.
  - New counter `osn.auth.passkey.login_discoverable{result}`.
  - `SecurityInvalidationTrigger` extended with `passkey_delete`.
  - Log redaction deny-list adds `attestation`, `passkeyLabel`/`passkey_label`.

## 0.13.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

## 0.12.0

### Minor Changes

- dc8c384: Auth phase 5a: step-up (sudo) ceremonies, session introspection/revocation, and email change.

  **New features**

  - **Step-up (sudo) tokens** — short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"` minted by a passkey or OTP ceremony, required by sensitive endpoints. Replay-guarded via `jti` tracking. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`.
  - **Session introspection + revocation** — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session now carries a coarse UA label (e.g. "Firefox on macOS"), an HMAC-peppered IP hash, and a `last_used_at` timestamp. Revocation handles are the first 16 hex chars of the session SHA-256.
  - **Email change** — `POST /account/email/{begin,complete}`, step-up-gated. Hard cap of 2 changes per trailing 7 days. Atomic with session invalidation so a partial failure can never leave a stale-email session alive. Audit rows persist in the new `email_changes` table.

  **Breaking changes**

  - `/recovery/generate` now requires a step-up token (`X-Step-Up-Token` header or `step_up_token` body param) with `webauthn` or `otp` amr. The old "1 per day" rate limit is replaced by a per-hour throttle; the step-up gate is the real defence.
  - `Session` no longer carries `refreshToken` — the refresh token is HttpOnly-cookie-only after C3. `AccountSession` drops `refreshToken` and adds `hasSession: boolean`. Any stored client session state will fail schema validation and be silently cleared (users will re-login).
  - `POST /logout` no longer accepts `refresh_token` in the body — cookie-only.

  **Observability**

  - New metrics: `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}`.
  - New `SecurityInvalidationTrigger` enum members: `session_revoke`, `session_revoke_all`.
  - New redaction deny-list entries: `stepUpToken`, `ipHash`, `uaLabel` (both spellings).

  Migration `0005_sessions_metadata_and_email_change.sql` adds `sessions.ua_label`, `sessions.ip_hash`, `sessions.last_used_at`, and the new `email_changes` table.

## 0.11.0

### Minor Changes

- 9459f5e: feat(auth): recovery codes (Copenhagen Book M2) + short-lived access tokens

  **Recovery codes (M2)**

  - 10 × 64-bit single-use codes per generation (`xxxx-xxxx-xxxx-xxxx`), SHA-256 hashed at rest in the new `recovery_codes` table.
  - `POST /recovery/generate` (Bearer-auth, 3/hr/IP) returns the raw codes exactly once; regenerating atomically invalidates the prior set.
  - `POST /login/recovery/complete` (5/hr/IP) consumes a code, revokes every session on the account, and establishes a fresh session + cookie.
  - `@shared/crypto` exports `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode`.
  - `@osn/client` exposes `createRecoveryClient`; `@osn/ui` ships `RecoveryCodesView` and `RecoveryLoginForm`.
  - Observability: `osn.auth.recovery.codes_generated`, `osn.auth.recovery.code_consumed{result}`, `osn.auth.recovery.duration`; spans `auth.recovery.{generate,consume}`; redaction deny-list additions for recovery fields.

  **Short-lived access tokens**

  - Default access-token TTL cut from 3600s to 300s (breaking for third-party consumers that cached past `expires_in`).
  - New `OsnAuthService.authFetch(input, init)` (also exposed via the SolidJS `useAuth()` context) silent-refreshes on 401 via the HttpOnly session cookie and retries once; surfaces `AuthExpiredError` when refresh fails.

  **Migration**

  - New Drizzle migration `osn/db/drizzle/0004_add_recovery_codes.sql`.
  - `AuthRateLimiters` gains `recoveryGenerate` and `recoveryComplete` (Redis bundle auto-populated).

  Mitigates prior backlog items: `S-M20` (refresh tokens in localStorage — now paired with a 5-min access-token ceiling) and unblocks M-PK (passkey-primary migration).

## 0.10.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

## 0.9.0

### Minor Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

## 0.8.0

### Minor Changes

- fe55da8: Implement kid-based ARC key auto-rotation. Adds service_account_keys table (per-key rows, zero-downtime rotation). ArcTokenClaims now requires a kid field (JWT header). resolvePublicKey now takes (kid, issuer, scopes). pulse/api auto-rotates ephemeral keys via startKeyRotation(). Migrates pulse/api graph bridge from in-process imports to ARC-token authenticated HTTP calls against /graph/internal/\* endpoints.

## 0.7.2

### Patch Changes

- a723923: feat(core): Multi-account P6 — Privacy audit

  - Add `passkeyUserId` column to `accounts` table (random UUID, generated at account creation) to prevent WebAuthn-based profile correlation — passkey registration now uses this opaque ID instead of `accountId` as the WebAuthn `user.id`
  - Add `accountId` / `account_id` to the observability redaction deny-list as defence in depth against log-based correlation
  - Add privacy invariant test suite verifying `accountId` never leaks in API responses, token claims, or profile data
  - Audit confirmed: all route responses, span attributes, metric attributes, and rate limit keys are clean

## 0.7.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.

## 0.7.0

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

## 0.6.0

### Minor Changes

- e2ef57b: Add organisation support with membership and role management

## 0.5.3

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @shared/db-utils@0.2.2

## 0.5.2

### Patch Changes

- e8b4f93: Add close friends to the OSN graph properly

  - Add `isCloseFriendOf` and `getCloseFriendsOfBatch` helpers to the graph service
  - Add `GET /graph/close-friends/:handle` status check endpoint
  - Instrument close friend operations with metrics (`osn.graph.close_friend.operations`) and tracing spans
  - Fix `removeConnection` to clean up close-friend entries in both directions (consistency bug)
  - Transaction-wrap `removeConnection` and `blockUser` multi-step mutations
  - Add `close_friends_friend_idx` index on `friend_id` for reverse lookups
  - Clamp `getCloseFriendsOfBatch` input to 1000 items (SQLite variable limit)
  - Sanitize error objects in graph operation log annotations
  - Migrate Pulse graph bridge from raw SQL to service-level `getCloseFriendsOfBatch`
  - Add `GraphCloseFriendAction` attribute type to shared observability

## 0.5.1

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
  - @shared/db-utils@0.2.1

## 0.5.0

### Minor Changes

- 45248b2: feat(crypto): ARC token system for service-to-service authentication

  - ES256 key pair generation (`generateArcKeyPair`)
  - JWT creation and verification (`createArcToken`, `verifyArcToken`)
  - Scope validation and audience enforcement
  - Public key resolution from `service_accounts` DB table (`resolvePublicKey`)
  - In-memory token cache with 30s-before-expiry eviction (`getOrCreateArcToken`)
  - JWK import/export utilities
  - `service_accounts` table added to `@osn/db` schema
  - 16 tests covering all functions

- 45248b2: feat: expand seed data with 20 users, social graph, event RSVPs

  - osn-db: 20 seed users with 25 connections and 3 close friends
  - pulse-db: `event_rsvps` table for tracking attendance
  - pulse-db: 15 seed events across 8 creators with 72 RSVPs
  - Fix effect version alignment across all packages (resolves pre-existing type errors)

## 0.4.0

### Minor Changes

- 623ad9f: Add social graph data model: connections, close friends, blocks.

  `@osn/db` — three new Drizzle tables: `connections` (pending/accepted requests), `close_friends` (unidirectional inner circle), `blocks` (unidirectional mutes/blocks). Exported inferred types for each.

  `@osn/core` — new `createGraphService` (Effect.ts, all graph operations) and `createGraphRoutes` (JWT-authenticated Elysia routes). Endpoints under `/graph/connections`, `/graph/close-friends`, `/graph/blocks`.

## 0.3.0

### Minor Changes

- 9caa8c7: Add user handle system

  Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

  - **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
  - **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
  - **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
  - **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility

## 0.2.3

### Patch Changes

- 05a9022: Add event ownership enforcement: `createdByUserId NOT NULL` on events, auth required for POST/PATCH/DELETE, ownership check (403) on mutating operations, `createdByName` derived server-side from JWT email claim, index on `created_by_user_id`, `updateEvent` eliminates extra DB round-trip.

## 0.2.2

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

## 0.2.1

### Patch Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

## 0.2.0

### Minor Changes

- 880e762: Split `packages/db` into `packages/osn-db` (`@osn/db`) and `packages/pulse-db` (`@pulse/db`). Each app now owns its database layer: OSN Core owns user/session/passkey schema, Pulse owns events schema. Replace Valibot with Effect Schema in the events service — `effect/Schema` is used for service-layer domain validation and transforms (e.g. ISO string → Date), while Elysia TypeBox remains at the HTTP boundary for route validation and Eden type inference.

### Patch Changes

- 880e762: Add `@utils/db` package (`packages/utils-db`) with shared database utilities — `createDrizzleClient` and `makeDbLive` — eliminating boilerplate duplication between `@osn/db` and `@pulse/db`. Both db packages now delegate client creation and Layer setup to `@utils/db`. Also removes the unused singleton `client.ts` export from both db packages.
- Updated dependencies [880e762]
  - @utils/db@0.2.0
