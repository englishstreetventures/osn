---
"@cire/api": patch
---

Wire cire-api wrangler config for production: set the real prod D1 `database_id`, add the organiser portal origin to the prod `WEB_ORIGIN` allowlist (placeholder pending real domain), flag the OSN issuer/JWKS URLs as required-before-prod, and redeclare D1 + R2 bindings under `[env.production]` (named envs do not inherit top-level bindings).
