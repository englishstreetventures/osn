# @shared/redis

## 0.2.2

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.1

### Patch Changes

- 19c39ba: feat(redis): wire up Redis-backed rate limiters (Phase 3)

  - Add `createRedisAuthRateLimiters()` and `createRedisGraphRateLimiter()` factories
    in `@osn/core` that build Redis-backed rate limiters from a `RedisClient`
  - Add `createClientFromUrl()` to `@shared/redis` so consumers don't need ioredis
    as a direct dependency
  - Wire env-driven backend selection in `@osn/app`: `REDIS_URL` set → Redis with
    startup health check; unset → in-memory fallback; graceful degradation on
    connection failure
  - All 12 rate limiters (11 auth + 1 graph) now use Redis when available
  - Resolves S-M2 (rate limiter resets on restart) for production deployments

## 0.2.0

### Minor Changes

- 115688b: feat(redis): add @shared/redis package (Phase 2 of Redis migration)

  New `@shared/redis` workspace with Effect-based Redis service for rate limiting and auth state stores:

  - `RedisClient` interface with ioredis adapter (`wrapIoRedis`) and in-memory fallback (`createMemoryClient`)
  - `Redis` Effect Context.Tag with `RedisLive` (ioredis + REDIS_URL) and `RedisMemoryLive` (dev/test) layers
  - `createRedisRateLimiter` — atomic INCR + PEXPIRE Lua script, fail-closed posture (S-M36)
  - `checkRedisHealth` — PING-based health probe with configurable timeout
  - `RedisError` tagged error (`Data.TaggedError`)
  - 13 tests covering rate limiter (atomicity, window expiry, key independence, fail-closed), health probe, and Effect service layer
