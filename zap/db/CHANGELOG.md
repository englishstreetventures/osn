# @zap/db

## 0.5.5

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

## 0.5.4

### Patch Changes

- Updated dependencies [2a98413]
  - @shared/db-utils@0.5.0

## 0.5.3

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

## 0.5.2

### Patch Changes

- Updated dependencies [43a88ae]
  - @shared/db-utils@0.4.0

## 0.5.1

### Patch Changes

- a10d4bb: Make zap-api actually deployable to Cloudflare Workers (first prod bring-up). Fix two workerd-hostile module-load patterns: `zap/db/src/service.ts` now passes the bun:sqlite path as a thunk so `fileURLToPath(import.meta.url)` is deferred into the lazy Layer (never runs on workerd, where `import.meta.url` is undefined at deploy-eval); `zapGraphBridge.ts` resolves + https-validates `OSN_API_URL` lazily (at call time) instead of at module load (workerd `[vars]` populate `process.env` only at runtime). Adds the `zap.cireweddings.com` custom-domain route + `OSN_API_URL` prod var to `zap/api/wrangler.toml`.

## 0.5.0

### Minor Changes

- bce0fe4: Add a server-visible c2b (consumer-to-business) chat class to Zap: `chats.class`, plaintext `messages.body`, ARC-gated `/internal/chats` provisioning + message CRUD (scope `chat:c2b`), and c2b bodies in the DSAR export. Adds a dormant `deploy-zap-api` CI job (activates once the prod D1 is provisioned).

## 0.4.2

### Patch Changes

- f4b9c6b: Upgrade oxlint to 1.70; satisfy tightened vitest rules — add toThrow messages and fix standalone-expect in test suites

## 0.4.1

### Patch Changes

- Updated dependencies [5aa1594]
  - @shared/db-utils@0.3.1

## 0.4.0

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
  - @shared/db-utils@0.3.0

## 0.3.2

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

## 0.3.1

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

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @shared/db-utils@0.2.2

## 0.2.0

### Minor Changes

- 7349512: Add Zap messaging backend with chat and message services for event chat integration

  - Create `@zap/db` package with chats, chat_members, and messages schema (Drizzle + SQLite)
  - Create `@zap/api` package with Elysia server (port 3002), chat/message REST routes, Effect services, and observability metrics
  - Add `chatId` column to Pulse events schema for event-chat linking
  - Add `zapBridge` service in Pulse for provisioning event chats and managing membership
