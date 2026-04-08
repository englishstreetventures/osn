---
"@osn/app": patch
"@osn/client": patch
"@osn/core": patch
"@osn/crypto": patch
"@osn/db": patch
"@osn/landing": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/app": patch
"@pulse/db": patch
"@shared/db-utils": patch
"@shared/typescript-config": patch
---

Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

- `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
- `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
- `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
- `@utils/db` → `@shared/db-utils`
- `@osn/typescript-config` → `@shared/typescript-config`

`@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.
