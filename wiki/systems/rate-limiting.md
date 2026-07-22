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
  - "@pulse/api"
  - "@zap/api"
  - "@cire/api"
  - "@shared/rate-limit"
  - "@shared/redis"
last-reviewed: 2026-07-22
---

# Rate Limiting

OSN uses **per-IP fixed-window rate limiting** on all auth endpoints and **per-user** limiting on graph write endpoints. Two backends exist: **Redis** (production, cross-process) and **in-memory** (local dev fallback).

## Architecture

```
shared/rate-limit/src/                  # RateLimiterBackend interface + in-memory createRateLimiter + getClientIp + createWorkersRateLimiter
osn/api/src/lib/redis-rate-limiters.ts  # createRedisAuthRateLimiters() + createRedisGraphRateLimiter() + recommendation limiter
osn/api/src/lib/native-rate-limiters.ts # selectAuthRateLimiters() — routes 60s per-IP auth limiters onto the native Workers binding
osn/api/src/routes/auth/limiters.ts     # auth route limiter instances (one per endpoint group)
osn/api/src/routes/graph.ts             # graph write rate limiter (60 req/user/min)
osn/api/src/metrics.ts                  # osn.auth.rate_limited counter
osn/api/src/build-deps.ts               # buildAppDeps: clientIpConfig (trustCloudflare) + native-vs-Redis limiter selection
osn/api/src/index.ts                    # Workers entry: reads native bindings + sets trustCloudflare for non-local
osn/api/wrangler.toml                   # [[ratelimits]] tiers + [observability] (mirrored into every named env)
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

## Native Workers Rate Limiting (osn-api, behind Cloudflare)

osn-api runs on Cloudflare Workers. The **60-second-window, per-IP auth limiters** run on the **Cloudflare Workers native Rate Limiting binding** (the GA `[[ratelimits]]` binding) instead of Upstash — global + atomic enforcement at the edge, with no per-request Upstash REST round-trip on the auth hot path. The wrapper `createWorkersRateLimiter(binding)` lives in `@shared/rate-limit` (shared with cire-api) and satisfies the same `RateLimiterBackend` contract, so route call sites are unchanged and **fail-closed** (a binding throw → deny).

**What moved vs what stayed:**

| Limiter group | Backend | Why |
|---|---|---|
| 60s-window per-IP auth limiters (register/login/passkey/step-up-complete/session/security-event/passkey-mgmt/cross-device — 25 endpoints) | **Native binding** | Brute-force-facing pre-auth throttles; the native binding's global+atomic edge enforcement beats the per-isolate in-memory fallback |
| 1-hour-window per-IP limiters (`recoveryGenerate`, `recoveryComplete`, `emailChangeBegin`) | **Upstash** | The native binding only supports `period` 10 or 60s — 1-hour windows cannot move |
| Per-user / per-account limiters (graph/org writes, recommendations, `profileSwitchCap`, `emailChangeBeginCap`) | **Upstash** | Keyed by user/account, not IP |
| Stateful stores (recovery lockout, step-up JTI, rotated-session, ceremony stores) | **Upstash** | Need durable cross-isolate state |

So the change **reduces but does not remove** the Upstash dependency — `UPSTASH_*` stays required in non-local (S-L1 gate).

**Tiers + keying.** The native binding's `limit`/`period` live in `wrangler.toml`, so there is one binding per request-budget tier (`RL_AUTH_IP_{5,10,20,30,60}_60`, each `simple = { limit, period = 60 }`), declared at top level **and mirrored into every named env** (named envs do NOT inherit top-level bindings). Each endpoint keeps its existing budget by mapping to the matching tier; `selectAuthRateLimiters` (`osn/api/src/lib/native-rate-limiters.ts`) namespaces the key as `"<endpoint>:" + ip` so endpoints sharing a tier never share a counter bucket. `selectAuthRateLimiters` runs **once per isolate** (inside the per-isolate-cached `buildAll`), not per request.

**Per-colo trade-off (accepted).** Cloudflare counts native rate limits **per colo**, not globally — a caller spread across colos sees a slightly looser effective cap. We approved this explicitly: a single attacker stays pinned to one colo, and the durable brute-force guards (recovery lockout) remain on Upstash. The `namespace_id`s (2001–2005) are account-scoped — verify they're unused in the account at deploy (S-L7).

**Observability.** `[observability]` is enabled in `wrangler.toml` (every tier) so Workers Logs/invocations are captured in the Cloudflare dashboard — interim while OTel export stays deferred on workerd (the redacting `osnLoggerLayer` is unchanged).

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
| `/register/complete`, `/login/passkey/begin`, `/login/passkey/complete`, `/passkey/register/{begin,complete}`, `/step-up/{passkey,otp}/complete`, `/account/email/complete`, `/handle/:handle` | 10 | Verify / complete — higher, to allow legitimate retries |
| `/login/recovery/complete` | 5/hr | Brute-force defence on the lost-device escape hatch |
| `/recovery/generate` | 1/day | Stop-gap for S-M1 — flood control on a destructive action |
| `PATCH /passkeys/:id` (rename) | 20 | Cheap settings action; label-only writes |
| `DELETE /passkeys/:id` | 10 | Step-up is the primary gate; per-IP throttle is defence in depth |
| `GET /passkeys` | 30 | Settings listing — cheap reads |

Graph write endpoints allow 60 requests per user per minute (S-M16). Recommendations reads (`/recommendations/connections`) allow 20 requests per user per minute — tighter because each call runs an FOF fan-out query (S-H1/P-C2).

### Zap (`@zap/api`)

Zap applies the same per-IP fixed-window limiter to its write endpoints
(`createDefaultZapRateLimiters` in `zap/api/src/routes/chats.ts`):
`POST /chats` 20/min, `POST /chats/:id/messages` 60/min,
`POST /chats/:id/members` 30/min. These sit in front of ES256/JWKS token
verification and the social-graph consent gate — see [[apps/zap]]. The limiter
check runs first so an unauthenticated flood is shed before any crypto or S2S
work.

### Pulse Per-User Write Limits (W4)

`@pulse/api` applies **per-user** fixed-window limiting to every authenticated write endpoint. The key is the JWT-asserted `claims.profileId`, **not** the client IP — so the Pulse write layer has no dependency on the `X-Forwarded-For` trust model (S-M34) that gates the unauthenticated reads. Limits live in one place (`pulse/api/src/lib/rate-limit.ts`, `PULSE_WRITE_LIMITS`) and are shared byte-for-byte between the in-memory defaults and the Redis namespaces.

| Endpoint | Limit | Rationale |
|----------|-------|-----------|
| `POST /events` (create) | 20 / 5 min | Heaviest write (insert + re-read); covers a power-organiser batching a week of events |
| `PATCH /events/:id` (update) | 60 / min | Cheap, legitimately bursty (drag-resize, typo fix); matches osn graph-write posture |
| `POST /events/:id/rsvps` | 30 / min | User-initiated + idempotent; absorbs double-taps |
| `POST /events/:id/invite` | 10 / min | Organiser-only; fans out to many rows per call |
| `POST /events/:id/comms/blasts` | 5 / min | Most expensive/abusable write (SMS/email fan-out) |
| `POST /series` (create) | 10 / hr | Materialises many instances; hourly window |
| `PATCH /series/:id` | 60 / hr | Re-materialises future instances; generous for iterative editing |
| `POST/DELETE /close-friends/:id` | 60 / min | Tiny list writes; absorbs rapid picker toggling |

The shared `checkWriteRateLimit(limiter, endpoint, profileId)` helper runs the check **after** authentication (so anonymous callers get 401, not 429), is **fail-closed** (a thrown/rejected backend `check()` counts as rate-limited), and records the bounded `pulse.write.rate_limited{ endpoint }` counter on every deny. The `endpoint` attribute is the closed `PulseWriteEndpoint` union — same cardinality discipline as `AuthRateLimitedEndpoint`.

Pulse's composition root (`pulse/api/src/index.ts` + `pulse/api/src/redis.ts`) mirrors osn/api: it builds Redis-backed write limiters via `createRedisWriteRateLimiters` when `REDIS_URL` is set, and falls back to the in-memory client otherwise.

### Pulse Per-IP Read / Share Limits (W4 / P4)

The **unauthenticated** Pulse surfaces — `GET /events/discover`, `POST /events/:id/share`, `POST /events/:id/exposure` — are limited **per IP** (discover 60/min, share 60/min, exposure 120/min; the exposure ceiling is higher because legitimate page reloads, link previews, and bot scans of a sourced URL all register there). `getClientIp(headers, options)` resolves the keying IP under its spoofing-resistant trust policy (`PULSE_TRUSTED_PROXY_COUNT`, or `trustCloudflare` behind CF; `socketIp` wired from Bun's `server.requestIP` in direct mode). An **unresolved IP fails closed** (429) via `isUnresolvedIp` rather than sharing a single `unknown` bucket — see [[#Client-IP Trust Policy (S-M34)]]. Redis namespaces: `pulse:discover`, `pulse:share`, `pulse:exposure`. A deferred follow-up will bind these pings to an HMAC-signed share token so the counters cannot be inflated by a caller who simply replays the endpoint with a fresh IP.

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

Phase 1 of the [[redis]] migration introduced this abstraction so we can swap the in-memory backend for Redis without touching route code.

## Fail-Closed Posture (S-M36)

If the rate limiter backend throws (e.g. Redis connection failure), the check defaults to `false` (deny). This is the fail-closed posture -- an unresponsive backend blocks requests rather than allowing unlimited throughput. We added the try/catch wrapping after S-M36 found that async `check()` rejections surfaced as 500 errors instead of 429s.

## Proactive Sweep (P-W16)

The limiter evicts expired entries on every `check()` call when at least one window has passed since the last sweep. The `maxEntries` cap is a hard backstop; periodic sweeping keeps memory deterministic under normal load.

## Client-IP Trust Policy (S-M34)

`getClientIp(headers, options?)` in `@shared/rate-limit` resolves the keying IP under an explicit, **fail-closed** trust policy. Resolution order:

1. `trustCloudflare: true` → trust `cf-connecting-ip` only. Never falls back to `x-forwarded-for` (Cloudflare also sets XFF, but an attacker upstream of CF could pollute it). Missing/invalid → `UNRESOLVED_IP`.
2. `trustedProxyCount: N` (N > 0) → take the entry **N from the right** of `x-forwarded-for`. The right-most entry is the one the closest trusted proxy appended and is the only entry a client cannot forge — counting from the right is the only spoofing-resistant strategy. Chain missing / shorter than N / selected entry malformed → `UNRESOLVED_IP`.
3. otherwise (direct / dev) → trust the transport **socket peer** (`socketIp`, e.g. Bun `server.requestIP(request)?.address`) only; absent/invalid → `UNRESOLVED_IP`.

`isUnresolvedIp(ip)` reports the sentinel; `isValidIp(value)` is a cheap shape-only guard. **Callers MUST deny (429) on an unresolved IP** rather than rate-limiting on it — a shared "unknown" bucket is both a DoS amplifier (one attacker drains everyone's budget) and a spoofing bypass.

**Backward compatibility:** the no-options form `getClientIp(headers)` is `@deprecated` but preserved — it keeps the legacy left-most-XFF / `"unknown"` behaviour so un-migrated services still build. Hardening is opt-in per service via the options argument.

> **S-M5 (osn) — fixed 2026-07-03.** The last residual call site,
> `osn/api/src/routes/account-erasure.ts`, now threads `clientIpConfig` from
> `app.ts` and keys via `getClientIp(headers, { ...clientIpConfig, socketIp })`
> with the `isUnresolvedIp` → 429 deny, matching the auth + profile routes.
> No deprecated no-args `getClientIp(headers)` call remains in `osn/api`
> (`pulse/api`'s public venue/discover limiters still use it — their own
> Redis/Workers limiter migration is tracked separately). See
> [[changelog/security-fixes]].

**`@osn/api` wiring (now behind Cloudflare):** osn-api is deployed on Cloudflare Workers serving `id.cireweddings.com`, so every **non-local** tier now keys per-IP rate limiting on `cf-connecting-ip` **exclusively** (`trustCloudflare: true`), closing the XFF-spoof bypass. The Workers entry (`osn/api/src/index.ts` `buildAll`) sets `trustCloudflare: isNonLocal(env)`; `buildAppDeps` (`build-deps.ts`) then builds `clientIpConfig = { trustCloudflare: true }` for deployed tiers. `TRUSTED_PROXY_COUNT` is **ignored** in deployed tiers (it only feeds the legacy XFF/socket path on the local Bun dev server, where `trustCloudflare` is `false` and the per-request `socketIp` comes from Bun's `server.requestIP`). Under Cloudflare, the W3.3 startup warning about the proxy count stays suppressed. Unresolved IPs still deny (429) at the call sites via `isUnresolvedIp`. Pulse / Zap still use their own options; Cire is CF-aware in its own surface.

## Integration Notes — adopting the hardened policy

A consuming service migrates off the deprecated default by:

1. Deciding its edge topology and passing the matching option to `getClientIp`: `{ trustCloudflare: true }` behind Cloudflare, or `{ trustedProxyCount: N }` behind N trusted proxies (wire `socketIp` from the runtime's socket peer for direct/Bun deployments).
2. Treating `isUnresolvedIp(ip) === true` as **deny**, not as a bucket key.

- **Pulse** (`pulse/api/src/routes/{events,onboarding,venues}.ts`) and **Zap** (`zap/api/src/routes/chats.ts`) call `getClientIp(headers)` with no options today and run on Bun behind whatever proxy the deployment fronts them with — they adopt `{ trustedProxyCount: N }` (+ `socketIp`) when their own hardening workstreams land.
- **Cire** runs on Cloudflare Workers and has its own `cire/api/src/lib/client-ip.ts` (CF-aware already); when it consolidates onto `@shared/rate-limit` it passes `{ trustCloudflare: true }`.

## Known Limitations

- **`X-Forwarded-For` trust is now policy-gated (S-M34, fixed)** -- see Client-IP Trust Policy above. The residual caveat is operational: each service must declare its proxy topology (`TRUSTED_PROXY_COUNT` for `@osn/api`) or it falls back to socket-peer / unresolved-deny.
- **Fixed window** -- a burst at the window boundary can allow 2x the limit. Acceptable for auth endpoints; sliding window is overkill for current traffic.
- **In-memory fallback** -- when `REDIS_URL` is unset (or Redis unreachable at startup), rate limits are process-local and reset on restart. S-M2 is resolved for production (Redis-backed) but the dev fallback retains the limitation by design.

## Security Finding History

| ID | Status | Description |
|----|--------|-------------|
| S-H1 | Fixed | Rate limit all auth endpoints (per-IP fixed-window) |
| S-H2 | Fixed | `/handle/:handle` rate limited at 10 req/IP/min |
| S-M2 | Fixed | In-memory rate limiter resets on restart -- migrated to Redis (Phase 3) |
| S-M34 | Fixed | Trusted `X-Forwarded-For` without a reverse-proxy guarantee. `getClientIp` now takes a fail-closed `ClientIpOptions` trust policy (`trustCloudflare` / `trustedProxyCount` / `socketIp`); unresolved IPs are denied, not bucketed. `@osn/api` opts in via `TRUSTED_PROXY_COUNT`. Legacy no-options form kept `@deprecated` for incremental rollout. |
| S-M36 | Fixed | Async backend rejection was fail-open (now fail-closed) |
| P-W1 | Fixed | Graph rate-limit store grew without bound (now uses shared limiter) |
| P-W16 | Fixed | Auth rate limiter Maps swept proactively |

## Source Files

- [shared/rate-limit/src/](../../shared/rate-limit/src/) — `RateLimiterBackend` interface + in-memory implementation + `getClientIp` + `createWorkersRateLimiter`
- [osn/api/src/lib/redis-rate-limiters.ts](../../osn/api/src/lib/redis-rate-limiters.ts) — Redis-backed rate limiter factories
- [osn/api/src/lib/native-rate-limiters.ts](../../osn/api/src/lib/native-rate-limiters.ts) — `selectAuthRateLimiters` (native binding routing for the 60s per-IP auth limiters)
- [osn/api/wrangler.toml](../../osn/api/wrangler.toml) — `[[ratelimits]]` tier bindings + `[observability]` (mirrored into every named env)
- [osn/api/src/routes/auth/limiters.ts](../../osn/api/src/routes/auth/limiters.ts) — auth route limiter instances
- [osn/api/src/routes/graph.ts](../../osn/api/src/routes/graph.ts) — graph route rate limiting
- [osn/api/src/metrics.ts](../../osn/api/src/metrics.ts) — `osn.auth.rate_limited` metric
- [osn/api/src/index.ts](../../osn/api/src/index.ts) — composition root with env-driven Redis/memory selection
- [shared/redis/src/rate-limiter.ts](../../shared/redis/src/rate-limiter.ts) — `createRedisRateLimiter()` Lua script backend
- [shared/observability/src/metrics/attrs.ts](../../shared/observability/src/metrics/attrs.ts) — `AuthRateLimitedEndpoint` type
- [pulse/api/src/lib/rate-limit.ts](../../pulse/api/src/lib/rate-limit.ts) — `PULSE_WRITE_LIMITS`, `checkWriteRateLimit`, in-memory defaults (W4)
- [pulse/api/src/lib/redis-rate-limiters.ts](../../pulse/api/src/lib/redis-rate-limiters.ts) — Pulse Redis-backed write + discover/share/exposure limiters
- [pulse/api/src/redis.ts](../../pulse/api/src/redis.ts) — Pulse Redis composition root (env-driven backend selection)
- [pulse/api/src/routes/events.ts](../../pulse/api/src/routes/events.ts) — per-IP discover/share/exposure limiting + `getClientIp` trust policy (P4)
- [CLAUDE.md](../../CLAUDE.md) — "Rate Limiting" section
