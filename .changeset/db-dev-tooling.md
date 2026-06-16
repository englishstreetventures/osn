---
"@cire/api": patch
"@cire/db": patch
"@osn/db": patch
"@pulse/db": patch
"@zap/db": patch
---

Local DB dev tooling — `db:reset` across the monorepo:

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
