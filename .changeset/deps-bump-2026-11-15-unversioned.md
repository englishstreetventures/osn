---
"@cire/api": patch
"@cire/build-tools": patch
"@cire/db": patch
"@cire/envelope": patch
"@cire/host": patch
"@cire/infra": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@cire/vendor": patch
"@tools/oxlint-house": patch
---

Dependency bumps that cleared the waiting rules on 2026-11-15: `effect` and the
`@effect/*` packages 4.1.4 (with the root overrides for `@effect/sql-d1` and
`@effect/platform-node-shared`), `astro` 7.4.11, `@astrojs/solid-js` 7.1.5,
`@astrojs/cloudflare` 14.4.7, `@elysiajs/openapi` 1.4.17 (escapes OpenAPI
values in the Swagger UI and Scalar pages), `@opentelemetry/*` 2.12.1 and
0.223.1, `jose` 6.2.17, `turbo` 2.11.11, `portless` 0.15.13, `nitro`
3.0.261103-rc, `@solidjs/start` 2.1.0, `wrangler` 4.156.1 (with the root override of `@cloudflare/vite-plugin` raised to 1.67.0, the release that pins that Wrangler, so the tree carries one Wrangler), `oxlint` and
`@oxlint/plugins` 1.90.0, `lucide-solid` 1.66.0, `@shadcn/lint` 0.2.3, and
`three` and `@types/three` 0.187.0.

Effect's tracers now leave a successful span's status Unset rather than Ok.

`mime` stays on 4.0.7 in `@shared/infra`: Wrangler 4.156.1 still bundles 4.0.7,
and the asset upload types every file the way that copy does.
