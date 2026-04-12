---
"@shared/redis": minor
---

feat(redis): add @shared/redis package (Phase 2 of Redis migration)

New `@shared/redis` workspace with Effect-based Redis service for rate limiting and auth state stores:

- `RedisClient` interface with ioredis adapter (`wrapIoRedis`) and in-memory fallback (`createMemoryClient`)
- `Redis` Effect Context.Tag with `RedisLive` (ioredis + REDIS_URL) and `RedisMemoryLive` (dev/test) layers
- `createRedisRateLimiter` — atomic INCR + PEXPIRE Lua script, fail-closed posture (S-M36)
- `checkRedisHealth` — PING-based health probe with configurable timeout
- `RedisError` tagged error (`Data.TaggedError`)
- 13 tests covering rate limiter (atomicity, window expiry, key independence, fail-closed), health probe, and Effect service layer
