---
"@shared/db-utils": minor
"@zap/db": minor
"@zap/api": minor
---

Add a four-environment database story (local / dev / staging / prod) and
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
