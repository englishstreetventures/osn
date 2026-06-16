---
"@cire/api": patch
"@cire/db": patch
---

Local DB dev tooling — `db:reset` for cire:

- `cire/db` `db:seed` now runs `scripts/cire-db-seed.sh`, which seeds the local
  D1 and re-points the bootstrap wedding owner from `CIRE_DEV_OWNER_PROFILE_ID`
  (dev convenience — migration 0006 seeds the `usr_REPLACE_BEFORE_PROD`
  placeholder); `db:reset` = wipe D1 + push + seed.
- `cire/db` drizzle.config points `db:studio` at the local miniflare D1 sqlite.
- `cire/api` local dev server (`local.ts`) re-points the bootstrap wedding owner
  from `CIRE_DEV_OWNER_PROFILE_ID` so the signed-in account owns it (the dev
  server uses an in-memory seeded DB, not the persistent D1).
