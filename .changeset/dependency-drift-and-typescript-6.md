---
"@osn/landing": patch
"@osn/social": patch
"@osn/client": patch
"@osn/ui": patch
"@osn/api": patch
"@osn/db": patch
"@pulse/app": patch
"@pulse/api": patch
"@pulse/db": patch
"@zap/api": patch
"@zap/db": patch
"@shared/crypto": patch
"@shared/email": patch
"@shared/observability": patch
"@shared/osn-auth-client": patch
"@shared/rate-limit": patch
"@shared/redis": patch
---

Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

- Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
  everywhere they were behind; `@osn/landing` switched from pinned
  `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
  `^6.0.1`) used by the cire Astro apps.
- Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
  already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
  removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
  surfaced by the stricter compiler were fixed:
  - `@osn/social`: added the missing `src/vite-env.d.ts`
    (`/// <reference types="vite/client" />`) so side-effect CSS imports type
    again (TS2882).
  - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
    (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
  - `@pulse/api`: annotated `createClient`'s return type as
    `Treaty.Create<App>` to satisfy the tightened declaration-portability check
    (TS2883).
