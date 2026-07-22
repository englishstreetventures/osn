---
title: Database Environments (local / dev / staging / prod)
aliases:
  - D1 local D1
  - four environments
  - bun:sqlite to D1
tags:
  - systems
  - infrastructure
  - database
status: current
related:
  - "[[testing-patterns]]"
  - "[[backend-patterns]]"
  - "[[schema-layers]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-07-22
---

# Database Environments

OSN runs each service's database across **four environments**, with **two
drivers** behind a single driver-agnostic Drizzle type:

| Environment | Driver | Where it runs | How |
|---|---|---|---|
| `local` | **bun:sqlite** | Dev machine | `bun run dev` (Bun.serve) + in-memory unit tests |
| `dev` | **Cloudflare D1** | Locally *or* deployed | `wrangler dev --env dev` (miniflare local D1) or `wrangler deploy --env dev` |
| `staging` | **Cloudflare D1** | Deployed | `wrangler deploy --env staging` |
| `production` | **Cloudflare D1** | Deployed | `wrangler deploy --env production` |

`local` stays on bun:sqlite because it is the cheapest, fastest way to create a
fresh database per test (`new Database(":memory:")` resolves in microseconds and
needs no network or daemon). D1 cannot match that for unit tests — a D1 binding
only exists inside workerd/miniflare. So unit tests keep bun:sqlite, and one
Miniflare integration test per service covers the D1 path.

This mirrors how [[cire-auth|Cire]] already works (D1 at runtime, bun:sqlite for
dev + tests) and generalises it to the rest of the monorepo.

## The driver-agnostic seam (`@shared/db-utils`)

A single broadened Drizzle type lets the *same* query code run on both drivers:

```ts
// drizzle handle broadened over bun:sqlite (sync) AND D1 (async) result kinds
export type Db<S> = BaseSQLiteDatabase<"sync" | "async", unknown, S>;
```

Because the result kind is `"sync" | "async"`, every `.all()` / `.get()` /
`.run()` resolves to `T | Promise<T>` — so service code **must `await`** (in
practice via `Effect.tryPromise` or the `dbQuery` bridge). Awaiting a synchronous
bun:sqlite result is a harmless no-op; D1 returns a real Promise.

`@shared/db-utils` exports:

- `makeDbLive(tag, path, schema)` — bun:sqlite layer (the `local` env).
- `createD1Db(binding, schema)` / `makeD1DbLive(tag, binding, schema)` — D1
  layer, built per-isolate from `env.DB` inside the Workers entry.
- `dbQuery(() => …)` — normalises a sync-or-Promise Drizzle result into an
  `Effect` (use `Effect.tryPromise` instead when you need a typed error).

## Per-service wiring

Each migrated API is factored into a `createApp({ dbLayer })` factory
(`new Elysia({ aot: false })` — Workers forbid Elysia's `new Function` AOT
codegen) plus two entry points:

- `src/local.ts` — long-lived `Bun.serve` over the bun:sqlite `DbLive` layer.
- `src/index.ts` — Workers `fetch` handler that builds the app once per isolate
  over `makeDbD1Live(env.DB)`, failing closed with a 503 when `DB` is missing.

`wrangler.toml` declares one `[[env.<name>.d1_databases]]` binding per D1
environment. The db package's `db:migrate:*` scripts apply Drizzle-generated
migrations to each:

```bash
bun run --cwd zap/db db:migrate:local     # miniflare local D1 (for `wrangler dev`)
bun run --cwd zap/db db:migrate:dev       # remote dev D1
bun run --cwd zap/db db:migrate:staging
bun run --cwd zap/db db:migrate:prod
```

## ⚠️ D1 has no interactive transactions

The one real incompatibility: **D1 does not support `db.transaction(async tx =>
…)`** (interactive read-then-conditional-write). It offers only `db.batch([…])`
— an atomic list of pre-built statements with no intermediate reads.

The fix is the shared `commitBatch(db, statements)` helper in `@shared/db-utils`:
it feature-detects the driver and runs the write set as a single atomic
`db.batch([...])` on D1, or sequentially (awaited, in FK order) on bun:sqlite.
Service code builds its statements up front instead of opening a transaction.
Three rewrite shapes recur:

1. **Pure write sets** (cascade deletes, swap-then-write) → drop straight into
   `commitBatch`.
2. **Read-then-write** (e.g. "pick the default-promotion target", "list hosted
   events") → run the read first, then `commitBatch` the writes. Safe because the
   subject (a profile/account being deleted) can't change between read and batch.
3. **Check-then-insert under a constraint** (handle/email uniqueness) → pre-check
   for a friendly error, then rely on the **UNIQUE constraint** as the
   authoritative race-safe guard (S-H1/S-M2 preserved), mapping the violation to
   a clean error. Count caps with no backing constraint (maxProfiles, passkey
   cap) become best-effort with a documented benign over-by-one race; the
   last-passkey invariant is kept race-safe with a **count-guarded conditional
   DELETE** (`… WHERE (SELECT COUNT(*) …) > 1`).

## Migration status

| Service | bun:sqlite (`local`) | D1 (`dev`/`staging`/`prod`) | Transactions |
|---|---|---|---|
| `@zap/api` | ✅ | ✅ (Miniflare-tested) | 0 |
| `@pulse/api` | ✅ | ✅ (Miniflare-tested) | 5 → `commitBatch` |
| `@osn/api` | ✅ | DB layer ✅ (Miniflare-tested) · Workers hosting ⛔ | 17 → `commitBatch` |
| `@cire/api` | ✅ (dev/tests) | ✅ (always was) | n/a (async from day 1) |

**`@osn/api` Workers-hosting caveat:** the DB layer is fully D1-ready and
Miniflare-tested, but the long-lived osn-api process also depends on **ioredis**
(rate-limiters, rotated-session + step-up JTI stores) and loads JWT keys from env
at module top level — neither runs on Cloudflare Workers. Hosting osn-api on
Workers needs a Workers-compatible Redis (e.g. Upstash REST) and request-scoped
key loading. Its `wrangler.toml` therefore has no `main`/deploy target yet — it
exists so that creating and migrating the osn D1 databases stays free. Tracked in
`wiki/TODO.md`.

**Region:** all four D1 databases (`cire-db` + osn-db dev/staging/prod) are in **`oc`
(Oceania / Sydney)**, and the Workers Redis (Upstash) is in **`ap-southeast-2`
(Sydney)** — co-located for low AU latency (the project is AU-centric). See
[[production-deploy]] for the database ids.

## Worker bundling: keep `bun:sqlite` out of the Worker

`bun:sqlite` is Bun-only — wrangler/esbuild cannot resolve it, so **any** static
import that reaches a Worker entry breaks `wrangler deploy`. Both the Bun host
and the Worker import the service → `@shared/db-utils` chain, so
`db-utils` must not statically import `bun:sqlite` (or `drizzle-orm/bun-sqlite`,
which pulls it transitively). `createDrizzleClient` therefore imports both
**dynamically via indirect specifiers** (`const m = "bun:sqlite"; await
import(m)`) so esbuild leaves them as runtime imports and bundles neither — the
code runs only on Bun (`local` + tests) and never executes on Workers.
So `makeDbLive` builds its layer asynchronously. Guard this with the
Worker build: `bun run --cwd <pkg> build` (= `wrangler deploy --dry-run`).

## Testing

Unit tests use `createTestLayer()` / bun:sqlite `:memory:` exactly as before —
see [[testing-patterns]]. The async D1 driver path gets one Miniflare-backed
integration test per service, co-located in `src/` so the vitest unit run
(globbing `tests/**`) skips it; run it explicitly:

```bash
bun run --cwd zap/api test:d1     # bun test src/d1-integration.test.ts
```

`@shared/db-utils` has direct unit tests for the `commitBatch` driver split
(empty no-op / D1 `batch` / sequential bun:sqlite fallback).
