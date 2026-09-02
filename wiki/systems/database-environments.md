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
  - "[[dev-environment]]"
last-reviewed: 2026-09-01
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
- `rowsChanged(result)` — how many rows a write touched. The drivers disagree
  here too: bun:sqlite and better-sqlite3 answer `{ changes }`, libsql
  `{ rowsAffected }`, D1 `{ success, meta: { changes } }`. Every rows-affected
  check must go through this. Reading the top-level fields alone passes on the
  bun:sqlite the tests run against and returns 0 for every write on D1, which
  inverted two of `@osn/api`'s compare-and-swap gates in production — see
  [[sessions]].

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
| `@osn/api` | ✅ | ✅ (Miniflare-tested) · **deployed** on Workers | 17 → `commitBatch` |
| `@cire/api` | ✅ (dev/tests) | ✅ (always was) | n/a (async from day 1) |

**`@osn/api` on Workers — done.** The old caveat here (ioredis and module-top-level
JWT key loading, neither of which runs on workerd) was resolved by the Upstash REST
client and request-scoped key loading. osn-api has been a deployed Worker since
2026-07-27 — `id.musubi.social` in production, `id.dev.musubi.social` on dev — and
CI deploys it. See [[musubi-identity-migration]] and [[dev-environment]].

**Databases and region.** All D1 databases are in **`oc` (Oceania / Sydney)** and
both Upstash Redis databases are in **`ap-southeast-2` (Sydney)** — co-located for
low AU latency (the project is AU-centric).

| Database | Environment | Id |
|---|---|---|
| `cire-db` | cire prod | `6e835474-e0a7-4db9-8883-3247c3c891cd` |
| `cire-db-dev` | cire dev | `bf0510eb-6998-4ee3-b5a0-833c646ef855` |
| `osn-db-prod` | osn prod | `767a9ac1-129b-4efa-9fcf-f68ed7a48c38` |
| `osn-db-dev` | osn dev | `1c1425e1-bb9f-4760-b090-763ccf61eb83` |
| `osn-db-staging` | unused | `eb71428e-8540-4a30-815f-fb9cd4ae97ea` |
| `osn-db` | unused (pre-split) | `a1dfceb8-2e7a-48eb-a161-ad428f3ddff5` |
| `zap-db-prod` | zap prod | `9b75f81a-7439-412a-9aad-cf47836bca07` |

The account holds **7 of the free plan's 10** D1 databases. `staging` is declared
in wrangler but not part of any pipeline — the dev tier is the only step before
production. See [[free-tier-limits]].

The `dev` row above is a **deployed, isolated tier**, not the "run it locally"
sense of the word used in the table at the top of this page. Both meanings are
live: `wrangler dev --env dev` still points a local miniflare D1 at the same
config block.

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
integration test per service, at `tests/d1/d1-integration.test.ts` (cire's at
`tests/db/d1-integration.test.ts`). The vitest configs exclude that path, so the
unit run skips it; run it explicitly:

```bash
bun run --cwd zap/api test:d1     # bun test tests/d1/d1-integration.test.ts
```

`@shared/db-utils` has direct unit tests for the `commitBatch` driver split
(empty no-op / D1 `batch` / sequential bun:sqlite fallback).
