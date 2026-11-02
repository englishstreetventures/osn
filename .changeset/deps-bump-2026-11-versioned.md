---
"@musubi/infra": patch
"@musubi/landing": patch
"@musubi/social": patch
"@osn/api": patch
"@osn/auth-ui": patch
"@osn/client": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/infra": patch
"@pulse/landing": patch
"@pulse/web": patch
"@shared/color": patch
"@shared/coordination": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/design-tokens": patch
"@shared/dev-urls": patch
"@shared/email": patch
"@shared/feature-flags": patch
"@shared/infra": patch
"@shared/legal": patch
"@shared/observability": patch
"@shared/openapi-tools": patch
"@shared/osn-auth-client": patch
"@shared/rate-limit": patch
"@shared/realtime": patch
"@shared/rp-auth": patch
"@shared/sortable": patch
"@shared/toast": patch
"@shared/turnstile": patch
"@shared/ui": patch
"@tools/lab": patch
"@tools/metrics": patch
"@zap/api": patch
"@zap/db": patch
"@zap/infra": patch
---

Dependency bumps within the caution window: `effect`, `@effect/platform-bun`,
`@effect/platform-node`, `@effect/sql-d1` and `@effect/opentelemetry` 4.0.7
(with the matching root overrides for `@effect/platform-node-shared`,
`@effect/sql-d1` and `@effect/sql-sqlite-do`), `jose` 6.2.14, `astro` 7.4.4,
`@astrojs/solid-js` 7.1.0, `@opentelemetry/*` 0.223.0 and 2.12.0,
`@growthbook/growthbook` 1.8.0, `@solidjs/start` 2.0.6, `cropperjs` 2.3.1,
`lucide-solid` 1.59.0, `motion` 13.5.1, `vitest` and the `@vitest/*` packages
5.0.5 (which clears the moderate dev-server file-read advisory). The root
overrides for `@opentelemetry/core` (`^2.12.0`) and `seroval` (`~1.6.11`, which
clears two moderate serialisation advisories) rise with them. `wrangler` stays on 4.149.0, which
`@cloudflare/vite-plugin` pins exactly. `solid-js` stays on 1.9.15 (see the cire
changeset for why).
