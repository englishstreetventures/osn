# @utils/db

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
