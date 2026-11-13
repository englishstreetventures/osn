---
"@shared/infra": minor
"@musubi/infra": minor
"@zap/infra": minor
"@osn/api": patch
"@osn/db": patch
"@zap/api": patch
"@zap/db": patch
---

Alchemy is the migrator of every production database. `flattenMigrations()` writes production's extra files (refusing placeholders for archived names, and the freeze of Wrangler's `d1_migrations`) and `migrationFiles()` lists them; `retainedD1Props()` names the `__alchemy_migrations` table; `read:live` reads each migrated database's ledger through D1's `/query`, keeping counts only, and the plan guard refuses a ledger Alchemy could not convert or would replay from, and a frozen ledger whose trigger is gone (`readLedger()`, `countLedger()`, `judgeLedger()`). The musubi and zap stacks declare `osn-db-prod` and `zap-db-prod` with their migrations, and `migrate:production` deploys each database alone before the release's deploy. The `[env.production]` D1 blocks of `osn/api` and `zap/api` name no `migrations_dir`, and `osn/db` and `zap/db` drop `db:migrate:prod`. `bun run --cwd shared/infra test:d1` proves the conversion on local copies of each database.
