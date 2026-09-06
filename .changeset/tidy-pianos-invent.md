---
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
"@osn/landing": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/landing": patch
"@pulse/web": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/dev-urls": patch
"@shared/email": patch
"@shared/feature-flags": patch
"@shared/legal": patch
"@shared/observability": patch
"@shared/openapi-tools": patch
"@shared/osn-auth-client": patch
"@shared/rate-limit": patch
"@shared/redis": patch
"@shared/rp-auth": patch
"@shared/sortable": patch
"@shared/toast": patch
"@shared/turnstile": patch
"@tools/lab": patch
"@zap/api": patch
"@zap/db": patch
---

Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.
