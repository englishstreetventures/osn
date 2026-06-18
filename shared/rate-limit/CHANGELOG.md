# @shared/rate-limit

## 0.3.0

### Minor Changes

- dbed689: Rate-limit + IP-trust hardening for osn-api behind Cloudflare.

  - **Client-IP trust (security fix):** the non-local Workers runtime now keys per-IP rate limiting on `cf-connecting-ip` exclusively (`trustCloudflare: true`), never the spoofable `x-forwarded-for`. This closes the bypass where an attacker forged XFF to rotate past the per-IP auth limits. Local Bun dev keeps socket-peer keying; `TRUSTED_PROXY_COUNT` is now ignored in deployed tiers. Unresolved IPs still deny (429), never bucket-share.
  - **Native Workers rate limiting:** the 60-second-window per-IP auth limiters move off Upstash onto the Cloudflare Workers native Rate Limiting binding (global + atomic at the edge, fail-closed). The three 1-hour-window per-IP limiters (recovery generate/complete, email-change-begin), every per-user/per-account limiter, and every stateful store stay on Upstash. `createWorkersRateLimiter` + `WorkersRateLimitBinding` are now shared from `@shared/rate-limit`.
  - **Workers observability:** `[observability]` enabled in `osn/api/wrangler.toml` (and every named env) so Workers Logs/invocations are captured in the Cloudflare dashboard.

  Per-colo trade-off accepted: native rate limiting is counted per Cloudflare location, not globally. osn-api must be redeployed for the new bindings + observability to take effect.

- 5055e1a: Harden client-IP resolution for rate limiting (S-M34).

  `getClientIp` now accepts an optional `ClientIpOptions { trustedProxyCount?, trustCloudflare?, socketIp? }` and resolves the keying IP under an explicit trust policy that **fails closed**:

  - `trustCloudflare` → trust `cf-connecting-ip` only (never falls back to `x-forwarded-for`); missing/invalid → unresolved.
  - `trustedProxyCount > 0` → take the entry N-from-the-right of `x-forwarded-for` (spoofing-resistant); missing/short/malformed → unresolved.
  - otherwise (direct/dev) → trust the transport socket peer (`socketIp`) only; absent/invalid → unresolved.

  New exports: `UNRESOLVED_IP`, `isUnresolvedIp(ip)`, `isValidIp(value)`, and the `ClientIpOptions` type. The legacy no-options call form (`getClientIp(headers)`) is preserved and marked `@deprecated` — it keeps the old left-most-XFF / `"unknown"` behaviour so consumers can migrate incrementally; the hardened behaviour is opt-in via the options argument.

  `@osn/api` adopts the hardened path at its auth + profile rate-limit call sites: the composition root reads `TRUSTED_PROXY_COUNT` (validated integer, default 0 = direct/socket-peer mode), wires Bun's `server.requestIP` as `socketIp`, and emits a startup warning when a non-local deploy leaves it unset. Requests whose IP is unresolved are denied (429) rather than sharing a single bucket. Session-IP persistence uses the same resolved IP.

## 0.2.2

### Patch Changes

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

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

## 0.2.1

### Patch Changes

- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).

## 0.2.0

### Minor Changes

- 1d9be5a: Extract `createRateLimiter`, `getClientIp`, and `RateLimiterBackend` into a new `@shared/rate-limit` package. `@zap/api` now imports directly from `@shared/rate-limit` and no longer depends on `@osn/core`.
