---
"@osn/core": minor
"@osn/app": minor
"@shared/redis": patch
---

feat(redis): wire up Redis-backed rate limiters (Phase 3)

- Add `createRedisAuthRateLimiters()` and `createRedisGraphRateLimiter()` factories
  in `@osn/core` that build Redis-backed rate limiters from a `RedisClient`
- Add `createClientFromUrl()` to `@shared/redis` so consumers don't need ioredis
  as a direct dependency
- Wire env-driven backend selection in `@osn/app`: `REDIS_URL` set → Redis with
  startup health check; unset → in-memory fallback; graceful degradation on
  connection failure
- All 12 rate limiters (11 auth + 1 graph) now use Redis when available
- Resolves S-M2 (rate limiter resets on restart) for production deployments
