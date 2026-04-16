---
"@shared/rate-limit": minor
"@osn/core": patch
"@zap/api": patch
---

Extract `createRateLimiter`, `getClientIp`, and `RateLimiterBackend` into a new `@shared/rate-limit` package. `@zap/api` now imports directly from `@shared/rate-limit` and no longer depends on `@osn/core`.
