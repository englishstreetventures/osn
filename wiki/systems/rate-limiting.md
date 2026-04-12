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
  - "@osn/core"
last-reviewed: 2026-04-12
---

# Rate Limiting

OSN uses **per-IP fixed-window rate limiting** on all auth endpoints. The implementation lives in [rate-limit.ts](../osn/core/src/lib/rate-limit.ts) and is consumed by `createAuthRoutes` in [auth.ts](../osn/core/src/routes/auth.ts).

## Architecture

```
osn/core/src/lib/rate-limit.ts     # Generic createRateLimiter + getClientIp
osn/core/src/routes/auth.ts        # 11 limiter instances, one per endpoint group
osn/core/src/metrics.ts            # osn.auth.rate_limited counter
shared/observability/src/metrics/
  attrs.ts                          # AuthRateLimitedEndpoint bounded union
```

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
| `/register/begin`, `/otp/begin`, `/magic/begin`, `/login/otp/begin`, `/login/magic/begin` | 5 | OTP/email send -- prevents email bombing |
| `/register/complete`, `/otp/complete`, `/magic/verify`, `/login/otp/complete`, `/login/passkey/begin`, `/login/passkey/complete`, `/passkey/register/begin`, `/passkey/register/complete`, `/handle/:handle` | 10 | Verify/complete -- slightly higher to allow legitimate retries |

Graph write endpoints are rate-limited at 60 requests per user per minute (S-M16).

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

- **In-memory only** -- resets on restart; not safe for multi-process. S-M2 tracks migration to a shared counter ([[redis|Redis]] / Cloudflare Durable Objects) for horizontal scaling.
- **Trusts `X-Forwarded-For`** -- clients can spoof the header without a trusted reverse proxy. S-M34 tracks adding a `trustProxy` config flag.
- **Fixed window** -- a burst at the window boundary can allow 2x the limit. Acceptable for auth endpoints; sliding window is overkill for current traffic.
- **Proactive sweep** -- expired entries are evicted on every `check()` call when at least one window has elapsed since the last sweep. The `maxEntries` cap is a hard backstop; periodic sweeping keeps memory deterministic under normal load.

## Security Finding History

| ID | Status | Description |
|----|--------|-------------|
| S-H1 | Fixed | Rate limit all auth endpoints (per-IP fixed-window) |
| S-H2 | Fixed | `/handle/:handle` rate limited at 10 req/IP/min |
| S-M2 | Open | In-memory rate limiter resets on restart -- migrate to Redis |
| S-M34 | Open | Trusts `X-Forwarded-For` without reverse-proxy guarantee |
| S-M36 | Fixed | Async backend rejection was fail-open (now fail-closed) |
| P-W1 | Fixed | Graph rate-limit store grew without bound (now uses shared limiter) |
| P-W16 | Fixed | Auth rate limiter Maps swept proactively |

## Source Files

- [osn/core/src/lib/rate-limit.ts](../osn/core/src/lib/rate-limit.ts) -- rate limiter implementation
- [osn/core/src/routes/auth.ts](../osn/core/src/routes/auth.ts) -- auth route limiter instances
- [osn/core/src/routes/graph.ts](../osn/core/src/routes/graph.ts) -- graph route rate limiting
- [osn/core/src/metrics.ts](../osn/core/src/metrics.ts) -- `osn.auth.rate_limited` metric
- [shared/observability/src/metrics/attrs.ts](../shared/observability/src/metrics/attrs.ts) -- `AuthRateLimitedEndpoint` type
- [CLAUDE.md](../CLAUDE.md) -- "Rate Limiting" section
