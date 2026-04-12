---
title: Redis Migration
aliases:
  - "@shared/redis"
  - Redis package
  - shared counter
tags:
  - systems
  - infrastructure
  - scaling
  - planned
status: in-progress
related:
  - "[[rate-limiting]]"
  - "[[arc-tokens]]"
  - "[[observability/overview]]"
finding-ids:
  - S-M2
  - S-M8
  - P-W1
  - P-W4
  - S-L18
  - S-L23
packages:
  - "@shared/redis"
  - "@osn/core"
last-reviewed: 2026-04-12
---

# Redis Migration

Migrate in-memory rate limiters and auth state stores to Redis for horizontal scaling. This is the S-M2 umbrella initiative that subsumes: S-M2, S-M8, P-W1, P-W4, S-L18, S-L23.

## Motivation

The current in-memory rate limiter and auth state stores (OTP codes, magic-link tokens, PKCE state, pending registrations) have fundamental limitations:

- **Reset on restart/deploy** -- all rate limit counters and pending auth flows are lost
- **Not safe for multi-process** -- each process has its own counter; horizontal scaling defeats rate limiting entirely
- **Unbounded memory growth** -- some stores (notably `pkceStore`) have no size bound or eviction (S-L23)

## Phase 1: Abstraction Layer (DONE)

No Redis dependency -- just the interfaces and refactoring.

- [x] Extracted `RateLimiterBackend` interface from `osn/core/src/lib/rate-limit.ts` -- backend-agnostic `check(key): boolean | Promise<boolean>`
- [x] Refactored graph route inline `rateLimitStore` + `checkRateLimit` (`osn/core/src/routes/graph.ts:10-30`) to use shared `createRateLimiter` from `rate-limit.ts` (fixes P-W1, S-L18)
- [x] Updated `createAuthRoutes` and graph route factories to accept injected rate limiter instances (DI for testability)

## Phase 2: @shared/redis Package (DONE)

Created the `@shared/redis` package following the `@shared/db-utils` pattern.

- [x] Create `shared/redis` workspace (`@shared/redis`) -- mirrors `@shared/db-utils` pattern
- [x] Effect-based `Redis` service tag (`Context.Tag`) + `RedisLive` layer (connection from `REDIS_URL` env); `Layer.scoped` finalizer calls `redis.quit()`
- [x] `RedisError` tagged error (`Data.TaggedError`, `_tag: "RedisError"`)
- [x] `createRedisRateLimiter(config)` -- Lua script for atomic INCR + PEXPIRE (single round-trip fixed-window); key format `rl:{namespace}:{key}`
- [x] Redis health probe for `/ready` endpoint (simple `PING` with timeout via `checkRedisHealth()`)
- [x] Dev-mode: in-memory fallback when `REDIS_URL` is unset -- `createMemoryClient()` + `RedisMemoryLive` layer
- [x] Tests: 13 tests across 3 files (rate limiter, health probe, Effect service layer)

## Phase 3: Wire Up (DONE)

Connected the Redis package to the existing rate limiting infrastructure.

- [x] Add `@shared/redis` dependency to `osn/core/package.json` and `osn/app/package.json`
- [x] `createClientFromUrl()` factory in `@shared/redis/client` — encapsulates ioredis constructor so consumers don't need ioredis as a direct dep
- [x] `createRedisAuthRateLimiters(client)` in `osn/core/src/lib/redis-rate-limiters.ts` — builds all 11 auth rate limiters with `auth:{endpoint}` namespaces
- [x] `createRedisGraphRateLimiter(client)` in same file — builds graph write limiter with `graph:write` namespace
- [x] Env-driven backend selection in `osn/app/src/index.ts`: `REDIS_URL` set → Redis-backed limiters; unset → in-memory fallback; startup health check with graceful fallback + logging
- [x] All 12 rate limiters (11 auth + 1 graph) now use Redis backends when available — fail-closed on individual check errors (S-M36), fail-open on infrastructure (startup fallback to in-memory)
- [x] Integration tests: 10 new tests verifying Redis-backed limiters integrate with route factories
- [x] Updated CLAUDE.md Rate Limiting section to document the two-backend model

## Phase 4: Auth State Migration (S-M8, follow-up)

Move volatile auth state from in-memory Maps to Redis with TTL.

- [ ] `otpStore` -> Redis with TTL (resolves S-M8 partial, P-W4 partial)
- [ ] `magicStore` -> Redis with TTL (resolves S-M8 partial, P-W4 partial)
- [ ] `pkceStore` -> Redis with TTL + size bound (resolves S-M8 partial, S-L23)
- [ ] `pendingRegistrations` -> Redis with TTL

## Observability Plan

Applied across all phases:

### Logs
- `Effect.logError` on Redis connection failures + command errors
- `Effect.logWarning` on fallback-to-in-memory transitions
- Add `redisPassword` / `redis_password` to redaction deny-list in `shared/observability/src/logger/redact.ts`

### Traces
- `Effect.withSpan("redis.rate_limit.check")`
- `Effect.withSpan("redis.connection.health")`
- `Effect.withSpan("redis.auth_state.get|set")` (Phase 4)

### Metrics

Metrics in `shared/redis/src/metrics.ts`:

| Metric | Type | Attributes |
|--------|------|------------|
| `redis.command.duration` | Histogram | `{ command: RedisCommand, result: RedisResult }` |
| `redis.command.errors` | Counter | `{ command: RedisCommand, error_type: RedisErrorType }` |
| `redis.connection.state` | UpDown Gauge | (up/down) |
| `redis.memory.bytes` | Gauge | (from periodic `INFO memory` -> `used_memory`; alert at 80% of `maxmemory`) |
| `redis.store.keys` | Gauge | `{ namespace: RedisNamespace }` |

Bounded attribute types:
- `RedisCommand = "evalsha" | "ping" | "get" | "set" | "del" | "incr" | "other"`
- `RedisResult = "ok" | "error" | "timeout"`
- `RedisNamespace = "rate_limit" | "otp" | "magic" | "pkce" | "pending_registration"`

## Deferred Decision: Provider Choice

| Option | Pros | Cons |
|--------|------|------|
| **Upstash** | Serverless, free tier, aligns with serverless deploy model | Latency for non-edge regions |
| **Redis Cloud** | Managed, mature | Cost at scale |
| **Self-hosted** | Full control, lowest cost | Ops burden |
| **Cloudflare Durable Objects** | Zero-latency at edge, no separate service | Vendor lock-in, reconsidered if deploying to Workers |

Decision deferred until deploying beyond localhost.

## Finding Cross-References

| ID | Phase | Description |
|----|-------|-------------|
| S-M2 | 3 (done) | In-memory rate limiter resets on restart -- umbrella finding (Redis-backed when REDIS_URL set) |
| S-M8 | 4 | Auth state in process memory -- lost on restart |
| P-W1 | 1 (done) | Graph rate-limit store grew without bound |
| P-W4 | 4 | Auth Maps never evict expired entries |
| S-L18 | 1 (done) | Graph rate-limit store never evicted expired windows |
| S-L23 | 4 | `pkceStore` has no size bound or eviction sweep |

## Source Files

- [shared/redis/src/index.ts](../shared/redis/src/index.ts) -- `@shared/redis` public API (Phase 2)
- [shared/redis/src/client.ts](../shared/redis/src/client.ts) -- `RedisClient` interface, `wrapIoRedis()`, `createMemoryClient()`, `createClientFromUrl()` (Phase 2+3)
- [shared/redis/src/service.ts](../shared/redis/src/service.ts) -- `Redis` Context.Tag, `RedisLive`, `RedisMemoryLive` layers (Phase 2)
- [shared/redis/src/rate-limiter.ts](../shared/redis/src/rate-limiter.ts) -- `createRedisRateLimiter()` with Lua script (Phase 2)
- [shared/redis/src/health.ts](../shared/redis/src/health.ts) -- `checkRedisHealth()` probe (Phase 2)
- [shared/redis/src/errors.ts](../shared/redis/src/errors.ts) -- `RedisError` tagged error (Phase 2)
- [osn/core/src/lib/rate-limit.ts](../osn/core/src/lib/rate-limit.ts) -- `RateLimiterBackend` interface (Phase 1)
- [osn/core/src/lib/redis-rate-limiters.ts](../osn/core/src/lib/redis-rate-limiters.ts) -- `createRedisAuthRateLimiters()`, `createRedisGraphRateLimiter()` factories (Phase 3)
- [osn/core/src/routes/auth.ts](../osn/core/src/routes/auth.ts) -- 11 auth rate limiter instances (wired to Redis in Phase 3)
- [osn/core/src/routes/graph.ts](../osn/core/src/routes/graph.ts) -- graph rate limiter (wired to Redis in Phase 3)
- [osn/app/src/index.ts](../osn/app/src/index.ts) -- composition root: env-driven Redis client + rate limiter wiring (Phase 3)
- [TODO.md](../TODO.md) -- "Redis Migration" section
