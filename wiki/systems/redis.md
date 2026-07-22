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
status: current
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
  - "@osn/api"
last-reviewed: 2026-07-22
---

# Redis Migration

Migrate in-memory rate limiters and auth state stores to Redis for horizontal scaling. One piece of work covers six findings: S-M2, S-M8, P-W1, P-W4, S-L18, S-L23.

## Motivation

The original in-memory rate limiter and the auth-state stores that need cross-process consistency (rotated session hashes for C2 reuse detection, step-up `jti` replay guard, pending WebAuthn challenges) shared three limitations:

- **Reset on restart/deploy** — all counters and pending auth flows were lost
- **Not safe for multi-process** — each process had its own state; horizontal scaling defeated rate limiting and could miss reuse detection
- **Unbounded memory growth** — some stores had no size bound or eviction

## What's done

| Phase | Scope | Status |
|---|---|---|
| **1 — Abstraction layer** | Extract `RateLimiterBackend` interface; refactor graph route to share the limiter; DI on every route factory | ✅ |
| **2 — `@shared/redis` package** | `Redis` service tag, `RedisLive` / `RedisMemoryLive` layers, Lua-backed `createRedisRateLimiter`, health probe, in-memory fallback | ✅ |
| **3 — Wire-up (rate limits)** | `createRedisAuthRateLimiters` / `createRedisGraphRateLimiter` / recommendation limiter; env-driven backend selection in `osn/api/src/index.ts`; fail-closed on individual check errors (S-M36); fail-open on startup fallback | ✅ |
| **4 — Cluster-safe auth state** | `RotatedSessionStore` (C2 reuse detection — see [[sessions]]) and `StepUpJtiStore` (single-use step-up replay guard — see [[step-up]]) both have Redis-backed implementations | ✅ |

`pkceStore`, `otpStore`, `magicStore`, `pendingRegistrations` no longer exist — the OTP/magic-link/PKCE primary login surfaces were deleted with the move to passkey-primary login (see [[passkey-primary]]).

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
- `RedisNamespace` (closed union, single source of truth in `shared/redis/src/metrics.ts`):
  - Pre-existing: `"rate_limit" | "rotated_session" | "step_up_jti"`
  - O3 ceremony / pending-state stores: `"reg_challenge" | "login_challenge" | "pending_registration" | "step_up_challenge" | "step_up_otp" | "pending_email_change" | "cross_device"`
  - O2 recovery-code lockout counter: `"recovery_lockout"`

### O3: ceremony / pending-state stores

Every short-lived ceremony / pending-state entry in the auth service (registration + login + step-up WebAuthn challenges, pending registrations, step-up OTP, pending email changes, cross-device requests) used to live in a process-local `Map` inside `auth.ts`. That was correct for single-process dev, but it split the state across pods in a multi-pod deployment: a `begin` on pod A and a `complete` routed to pod B gave a false "challenge expired", and a client could sidestep the per-account caps by hopping pods. Each entry now follows the injectable triple-pattern used by `StepUpJtiStore` / `RotatedSessionStore`: an interface (`CeremonyStore<V>`) on `AuthConfig.ceremonyStores`, an in-memory default (TTL-swept, `CEREMONY_STORE_MAX`-bounded), and a Redis-backed impl (one key per entry, native PX expiry) wired from a single `RedisClient` in `osn/api/src/index.ts` via `createRedisCeremonyStores`. The two per-account caps (profile-switch 20/hr, email-change-begin 3/24h) route through `createRedisRateLimiter`. **Fail-conservative:** a short Redis outage drops a ceremony to "not found / re-begin" rather than a 500. Per-namespace op + live-entry telemetry: `osn.auth.ceremony_store.operations` / `osn.auth.ceremony_store.entries`.

## Deferred Decision: Provider Choice

| Option | Pros | Cons |
|--------|------|------|
| **Upstash** | Serverless, free tier, aligns with serverless deploy model | Latency for non-edge regions |
| **Redis Cloud** | Managed, mature | Cost at scale |
| **Self-hosted** | Full control, lowest cost | Ops burden |
| **Cloudflare Durable Objects** | Zero-latency at edge, no separate service | Vendor lock-in, reconsidered if deploying to Workers |

Decision deferred until the first deploy beyond localhost. **Resolved: Upstash, region
`ap-southeast-2` (Sydney)** — co-located with the D1 databases (`oc`/Sydney) + AU edge
traffic for low latency (C-M18; see [[compliance/subprocessors]], [[production-deploy]]).

## Finding Cross-References

| ID | Status | Description |
|----|---|---|
| S-M2 | ✅ | In-memory rate limiter resets on restart — Redis-backed when `REDIS_URL` set |
| S-M8 | ✅ | Auth state in process memory — replaced with cluster-safe `RotatedSessionStore` + `StepUpJtiStore` |
| P-W1 | ✅ | Graph rate-limit store grew without bound — now uses shared limiter |
| P-W4 | ✅ | Auth Maps never evict expired entries — Redis backend uses native PX expiry |
| S-L18 | ✅ | Graph rate-limit store never evicted expired windows |
| S-L23 | n/a | `pkceStore` deleted with PKCE removal |

## Source Files

- [shared/redis/src/index.ts](../../shared/redis/src/index.ts) — `@shared/redis` public API
- [shared/redis/src/client.ts](../../shared/redis/src/client.ts) — `RedisClient` interface, `wrapIoRedis()`, `createMemoryClient()`, `createClientFromUrl()`
- [shared/redis/src/service.ts](../../shared/redis/src/service.ts) — `Redis` Context.Tag, `RedisLive`, `RedisMemoryLive` layers
- [shared/redis/src/rate-limiter.ts](../../shared/redis/src/rate-limiter.ts) — `createRedisRateLimiter()` with Lua script
- [shared/redis/src/health.ts](../../shared/redis/src/health.ts) — `checkRedisHealth()` probe
- [shared/redis/src/errors.ts](../../shared/redis/src/errors.ts) — `RedisError` tagged error
- [shared/rate-limit/src/](../../shared/rate-limit/src/) — `RateLimiterBackend` interface + in-memory implementation
- [osn/api/src/lib/redis-rate-limiters.ts](../../osn/api/src/lib/redis-rate-limiters.ts) — `createRedisAuthRateLimiters()`, `createRedisGraphRateLimiter()` factories
- [osn/api/src/lib/rotated-session-store.ts](../../osn/api/src/lib/rotated-session-store.ts) — `RotatedSessionStore` (in-memory + Redis impls)
- [osn/api/src/lib/step-up-jti-store.ts](../../osn/api/src/lib/step-up-jti-store.ts) — `StepUpJtiStore` (in-memory + Redis impls)
- [osn/api/src/index.ts](../../osn/api/src/index.ts) — composition root: env-driven Redis client + limiter / store wiring
- [TODO.md](../TODO.md) — "Redis Migration" section
