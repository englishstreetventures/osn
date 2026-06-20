# @zap/api

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
