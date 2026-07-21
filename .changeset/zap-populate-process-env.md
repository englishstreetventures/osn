---
"@zap/api": patch
---

Add the `nodejs_compat_populate_process_env` compatibility flag so `process.env.INTERNAL_SERVICE_SECRET` resolves in production (zap-api's `compatibility_date` predates the 2025-04-01 auto-populate cutoff). Fixes the `/internal/register-service` endpoint returning 501 "Service registration is disabled" and zap-api's own outbound ARC registration silently skipping — both of which read the secret via `process.env`.
