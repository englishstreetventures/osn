---
"@osn/core": patch
---

Remove the `rate-limit.ts` re-export shim and update all internal imports to `@shared/rate-limit` directly. `createRateLimiter`, `getClientIp`, and `RateLimiterBackend` are no longer exported from `@osn/core` — import from `@shared/rate-limit` instead.
