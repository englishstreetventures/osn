---
"@musubi/infra": patch
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/infra": patch
"@shared/billing": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/email": patch
"@shared/infra": patch
"@shared/observability": patch
"@shared/realtime": patch
"@zap/api": patch
"@zap/db": patch
"@zap/infra": patch
---

Every workspace runs `effect` 4.1.2, with `@effect/platform-bun`,
`@effect/platform-node`, `@effect/sql-d1`, `@effect/opentelemetry` and
`@effect/vitest` at 4.1.2 and the root overrides for
`@effect/platform-node-shared` and `@effect/sql-d1` with them. `alchemy`
2.0.0-beta.84 is patched (`patches/alchemy@2.0.0-beta.84.patch`) so it loads
on Effect 4.1: its OAuth helpers use Web Crypto, and its service types drop the
`Crypto` service 4.1 removed. `@shared/infra`'s state-CLI test also fails when
any installed Alchemy package names an Effect module the tree cannot resolve.
`RETIRED_STAGING_HOSTS` is gone from `@shared/infra`, and `domainRefusals()`
takes `(changes, unflip)`: a site's Worker gives up only its current spare host
without an `unflip` naming the site.
