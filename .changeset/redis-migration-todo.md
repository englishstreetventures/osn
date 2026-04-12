---
"@osn/core": minor
---

Add RateLimiterBackend abstraction and dependency injection for rate limiters (Redis migration Phase 1).

- Extract backend-agnostic `RateLimiterBackend` interface (`check(key): boolean | Promise<boolean>`) so routes can be wired to a future Redis backend without call-site changes
- Refactor graph route inline rate limiter to use shared `createRateLimiter` (fixes P-W1, S-L18: unbounded in-memory store with no eviction)
- Add `rateLimiters` parameter to `createAuthRoutes` and `rateLimiter` parameter to `createGraphRoutes` for DI
- Export `AuthRateLimiters`, `createDefaultAuthRateLimiters`, `createDefaultGraphRateLimiter`, `RateLimiterBackend` from `@osn/core`
- Add TODO.md Redis migration plan (S-M2 umbrella) with phased approach across 4 phases
