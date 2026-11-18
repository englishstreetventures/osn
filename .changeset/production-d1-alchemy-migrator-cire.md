---
"@cire/infra": minor
"@cire/api": patch
"@cire/db": patch
---

The cire stack migrates the production `cire-db` with Alchemy: it declares the database with its migrations (the live chain, a refusing placeholder under each archived name production's ledger holds, and the file that freezes Wrangler's `d1_migrations`), and `migrate:production` deploys the database alone before each release's deploy. The live read counts the database's migration ledger, counts only. `cire/api/wrangler.toml`'s `[env.production]` D1 block names no `migrations_dir` and its top-level block a local-only id (`local:cire-db`), so Wrangler's migrator reaches no deployed database; local data moves to a new file, rebuilt with `bun run --cwd cire/db db:reset`. `cire/db` drops `db:migrate:prod`.
