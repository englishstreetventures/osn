---
"@osn/api": patch
"@osn/db": patch
"@shared/observability": patch
---

Deploy OSN identity to its own dev tier, isolated from production.

The cire dev tier needs an identity provider it can break. `[env.dev]` in
`osn/api/wrangler.toml` was a set of localhost placeholders pointing at the
production `osn-db`; it is now a real deployed tier — route
`id.dev.musubi.social` (`custom_domain = true`), `OSN_RP_ID = "dev.musubi.social"`,
its own issuer and authorize-UI URLs, the `osn-db-dev` D1 database, five native
rate-limit namespaces on fresh ids, and its own `[env.dev.triggers]`. Dev
passkeys are separate credentials from production, which is the point.

Same `process.env` fix as `@cire/api`: this Worker also pins
`compatibility_date = "2025-03-01"` without
`nodejs_compat_populate_process_env`, so `loadConfig` resolved the `local` tier
in production and the logger picked the local format and level. The flag is
listed explicitly and the module-top-level read moves to request scope —
`process.env` populates lazily on first access, so the flag alone would not have
fixed a top-level read. The comment in `shared/observability` asserting that
`nodejs_compat` populates `process.env` was wrong and is corrected.

`@osn/db` gains the same per-env migrate script shape as the other db packages.
