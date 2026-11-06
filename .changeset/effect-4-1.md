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
`@effect/platform-node-shared` and `@effect/sql-d1` with them. The stacks run
`alchemy` and `@alchemy.run/cloudflare` 2.0.0-beta.85, which loads on Effect
4.1 unpatched; the provider's patch, carried to beta.85, keeps the D1 import
the stacks ran on beta.84 and the content types Wrangler uploads assets with.
beta.85 deploys state store version 8, which beta.84 cannot use, so a tier's
store cannot go back once it is upgraded.

The production plan guard reads beta.85's console lines
(`[hh:mm:ss.mmm] INFO: …`), and `messageOf()` reads no logfmt record.
`@shared/infra`'s tests hold the AWS SDK the provider installs,
`@distilled.cloud/aws`, to listing and aborting an R2 bucket's multipart
uploads, and run both under Bun. `RETIRED_STAGING_HOSTS` is gone from
`@shared/infra`, and `domainRefusals()` takes `(changes, unflip)`: a site's
Worker gives up only its current spare host without an `unflip` naming the
site.
