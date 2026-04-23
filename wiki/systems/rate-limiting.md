---
title: Rate Limiting
aliases:
  - rate limiter
  - per-IP rate limiting
  - fixed-window rate limiting
tags:
  - systems
  - security
  - auth
  - infrastructure
status: current
related:
  - "[[redis]]"
  - "[[arc-tokens]]"
  - "[[rate-limit-incident]]"
  - "[[observability/metrics]]"
finding-ids:
  - S-H1
  - S-H2
  - S-M2
  - S-M34
  - S-M36
  - P-W1
  - P-W16
packages:
  - "@osn/api"
  - "@shared/rate-limit"
  - "@shared/redis"
last-reviewed: 2026-04-23
---

# Rate Limiting

OSN uses **per-IP fixed-window rate limiting** on all auth endpoints and **per-user** limiting on graph write endpoints. Two backends are supported: **Redis** (production, cross-process) and **in-memory** (local dev fallback).

## Architecture

```
shared/rate-limit/src/                  # RateLimiterBackend interface + in-memory createRateLimiter + getClientIp
osn/api/src/lib/redis-rate-limiters.ts  # createRedisAuthRateLimiters() + createRedisGraphRateLimiter() + recommendation limiter
osn/api/src/routes/auth.ts              # auth route limiter instances (one per endpoint group)
osn/api/src/routes/graph.ts             # graph write rate limiter (60 req/user/min)
osn/api/src/metrics.ts                  # osn.auth.rate_limited counter
osn/api/src/index.ts                    # Composition root: env-driven Redis/memory backend selection
shared/redis/src/rate-limiter.ts        # createRedisRateLimiter() — Lua INCR+PEXPIRE
shared/observability/src/metrics/attrs.ts  # AuthRateLimitedEndpoint bounded union
```

## Backend Selection

At startup, `osn/api/src/index.ts` selects the rate limiter backend:

| `REDIS_URL` env var | Backend | Behaviour |
|---------------------|---------|-----------|
| Set | Redis via ioredis | Atomic Lua script (INCR+PEXPIRE), shared across processes, survives restarts |
| Unset | In-memory `createMemoryClient()` | Same semantics, process-local, resets on restart |

If `REDIS_URL` is set but Redis is unreachable at startup, the app falls back to in-memory with a warning log. Individual rate limit checks are always **fail-closed** (S-M36) — a Redis error during `check()` denies the request.

## When to Add Rate Limiting

| Scenario | Rate limit? | Key | Why |
|----------|-------------|-----|-----|
| New **unauthenticated** endpoint | **Yes** | IP (`getClientIp(headers)`) | No user identity; IP is the only option |
| New **authenticated** endpoint (write) | **Yes** | User ID | Already done for graph writes (`routes/graph.ts:12-31`) |
| New **authenticated** endpoint (read) | **Maybe** | User ID | Only if the read is expensive or enumerable |
| Internal S2S endpoint (ARC-gated) | **No** | -- | ARC tokens are machine-to-machine; rate limit at the service mesh level |

## How to Add a Rate Limiter

### Step 1: Create a limiter instance

Inside the route factory:

```typescript
import { createRateLimiter, getClientIp } from "../lib/rate-limit";
const rl = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });
```

### Step 2: Check at the top of the handler

```typescript
async ({ body, set, headers }) => {
  const ip = getClientIp(headers);
  if (!rl.check(ip)) {
    metricAuthRateLimited("endpoint_name");
    set.status = 429;
    return { error: "rate_limited" };
  }
  // ... handler logic
}
```

### Step 3: Add the endpoint name to the bounded union

Add the endpoint name to `AuthRateLimitedEndpoint` in [attrs.ts](../shared/observability/src/metrics/attrs.ts). This is a bounded union -- no free-form strings allowed.

### Step 4: Write a route test

Send `maxRequests + 1` requests and assert the last returns 429.

## Current Limits

| Endpoint group | Max req/IP/min | Rationale |
|----------------|----------------|-----------|
| `/register/begin`, `/step-up/otp/begin`, `/account/email/begin` | 5 | OTP / email send — prevents email bombing |
| `/register/complete`, `/login/passkey/begin`, `/login/passkey/complete`, `/passkey/register/{begin,complete}`, `/step-up/{passkey,otp}/complete`, `/account/email/complete`, `/handle/:handle` | 10 | Verify / complete — slightly higher to allow legitimate retries |
| `/login/recovery/complete` | 5/hr | Brute-force defence on the lost-device escape hatch |
| `/recovery/generate` | 1/day | Stop-gap for S-M1 — flood control on a destructive action |
| `PATCH /passkeys/:id` (rename) | 20 | Cheap settings action; label-only writes |
| `DELETE /passkeys/:id` | 10 | Step-up is the primary gate; per-IP throttle is defence in depth |
| `GET /passkeys` | 30 | Settings listing — cheap reads |

Graph write endpoints are rate-limited at 60 requests per user per minute (S-M16). Recommendations reads (`/recommendations/connections`) are rate-limited at 20 requests per user per minute — tighter because each call runs an FOF fan-out query (S-H1/P-C2).

## Config

```typescript
interface RateLimiterConfig {
  maxRequests: number;     // requests allowed per window
  windowMs: number;        // window duration in milliseconds
  maxEntries?: number;     // max distinct keys before expired-entry sweep (default: 10_000)
}
```

## Dependency Injection

Rate limiters are injected into route factories via a typed `AuthRateLimiters` object (declared `Readonly` after S-M37). Routes accept injected limiter instances for testability -- tests can provide custom limiters with different configs or mock backends.

The `RateLimiterBackend` interface abstracts the storage backend:

```typescript
interface RateLimiterBackend {
  check(key: string): boolean | Promise<boolean>;
}
```

This abstraction was introduced in Phase 1 of the [[redis]] migration to allow swapping the in-memory backend for Redis without touching route code.

## Fail-Closed Posture (S-M36)

If the rate limiter backend throws (e.g. Redis connection failure), the check defaults to `false` (deny). This is the fail-closed posture -- an unresponsive backend blocks requests rather than allowing unlimited throughput. The try/catch wrapping was added after S-M36 found that async `check()` rejections propagated as 500 errors instead of 429s.

## Proactive Sweep (P-W16)

Expired entries are evicted on every `check()` call when at least one window has elapsed since the last sweep. The `maxEntries` cap is a hard backstop; periodic sweeping keeps memory deterministic under normal load.

## Known Limitations

- **Trusts `X-Forwarded-For`** -- clients can spoof the header without a trusted reverse proxy. S-M34 tracks adding a `trustProxy` config flag.
- **Fixed window** -- a burst at the window boundary can allow 2x the limit. Acceptable for auth endpoints; sliding window is overkill for current traffic.
- **In-memory fallback** -- when `REDIS_URL` is unset (or Redis unreachable at startup), rate limits are process-local and reset on restart. S-M2 is resolved for production (Redis-backed) but the dev fallback retains the limitation by design.

## Security Finding History

| ID | Status | Description |
|----|--------|-------------|
| S-H1 | Fixed | Rate limit all auth endpoints (per-IP fixed-window) |
| S-H2 | Fixed | `/handle/:handle` rate limited at 10 req/IP/min |
| S-M2 | Fixed | In-memory rate limiter resets on restart -- migrated to Redis (Phase 3) |
| S-M34 | Open | Trusts `X-Forwarded-For` without reverse-proxy guarantee |
| S-M36 | Fixed | Async backend rejection was fail-open (now fail-closed) |
| P-W1 | Fixed | Graph rate-limit store grew without bound (now uses shared limiter) |
| P-W16 | Fixed | Auth rate limiter Maps swept proactively |

## Source Files

- [shared/rate-limit/src/](../../shared/rate-limit/src/) — `RateLimiterBackend` interface + in-memory implementation + `getClientIp`
- [osn/api/src/lib/redis-rate-limiters.ts](../../osn/api/src/lib/redis-rate-limiters.ts) — Redis-backed rate limiter factories
- [osn/api/src/routes/auth.ts](../../osn/api/src/routes/auth.ts) — auth route limiter instances
- [osn/api/src/routes/graph.ts](../../osn/api/src/routes/graph.ts) — graph route rate limiting
- [osn/api/src/metrics.ts](../../osn/api/src/metrics.ts) — `osn.auth.rate_limited` metric
- [osn/api/src/index.ts](../../osn/api/src/index.ts) — composition root with env-driven Redis/memory selection
- [shared/redis/src/rate-limiter.ts](../../shared/redis/src/rate-limiter.ts) — `createRedisRateLimiter()` Lua script backend
- [shared/observability/src/metrics/attrs.ts](../../shared/observability/src/metrics/attrs.ts) — `AuthRateLimitedEndpoint` type
- [CLAUDE.md](../../CLAUDE.md) — "Rate Limiting" section
