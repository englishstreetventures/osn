---
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
"@osn/landing": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/app": patch
"@pulse/db": patch
"@shared/crypto": patch
"@shared/observability": patch
"@shared/rate-limit": patch
"@shared/redis": patch
"@zap/api": patch
"@zap/db": patch
---

In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
