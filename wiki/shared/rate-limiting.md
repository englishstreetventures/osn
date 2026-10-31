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
  - "[[coordination-store]]"
  - "[[arc-tokens]]"
  - "[[rate-limit-incident]]"
  - "[[shared/observability/metrics]]"
packages:
  - "@osn/api"
  - "@pulse/api"
  - "@zap/api"
  - "@cire/api"
  - "@shared/rate-limit"
  - "@shared/coordination"
last-reviewed: 2026-10-28
---
# Rate Limiting

OSN uses **per-IP fixed-window rate limiting** on all auth endpoints and **per-user** limiting on graph write endpoints. osn-api's limiters run on three backends: Cloudflare's **native Rate Limiting bindings** (one-minute windows, deployed tiers), the **coordination store** (longer windows and per-account caps, deployed tiers — [[coordination-store]]) and **in-memory** counters (the Bun dev server and tests). Every limit is set once, in a budget table every backend reads.

## Architecture

```
shared/rate-limit/src/                   # RateLimiterBackend interface + in-memory createRateLimiter + getClientIp + createWorkersRateLimiter
shared/coordination/src/client.ts        # createCoordinationRateLimiter() — fixed window on the coordination store
osn/api/src/routes/auth/limiters.ts      # AUTH_RATE_LIMITS + OSN_RATE_LIMITS: every osn-api budget, set once
osn/api/src/lib/coordination/            # the two bundles every limiter comes from: in-memory and durable
osn/api/src/lib/native-rate-limiters.ts  # selectAuthRateLimiters() + selectOsnLimiters() — one-minute limiters onto native bindings
osn/api/src/routes/graph.ts              # graph write rate limiter (60 req/user/min)
osn/api/src/metrics.ts                   # osn.auth.rate_limited counter
osn/api/src/build-deps.ts                # buildAppDeps: clientIpConfig (trustCloudflare) + native-vs-store limiter selection
osn/api/src/index.ts                     # Workers entry: reads native bindings + sets trustCloudflare for non-local
osn/api/wrangler.toml                    # [[ratelimits]] tiers + [observability] (mirrored into every named env)
shared/observability/src/metrics/attrs.ts  # AuthRateLimitedEndpoint bounded union
```

## Backend Selection

`buildAppDeps` (`osn/api/src/build-deps.ts`) takes every limiter from the coordination bundle it is given, then moves each one-minute limiter onto its native binding when that binding is present:

| Runtime | Bundle | One-minute limiters | Behaviour |
|---|---|---|---|
| Deployed Worker (dev, staging, production) | `createDurableCoordination(env.COORDINATION)` | Native bindings | Shared by every isolate; survives restarts and deploys |
| `wrangler dev` (local tier) | The same, on Miniflare | Miniflare's local bindings | As deployed, on one machine |
| Bun dev server, tests | `createInMemoryCoordination()` | Stay in memory | Process-local, reset on restart |

Every check is **fail-closed**: a binding that throws or a coordination-store call that fails denies the request. A deployed Worker missing `COORDINATION`, or a non-local one missing either `RL_USER_*` binding, answers 503 on every route rather than fall back to per-isolate counters.

The in-memory limiter (`createRateLimiter`) does not count a refused hit, and sweeps expired keys once it holds more than 10,000. The coordination-store limiter counts every hit, refused ones included, and refuses a key over 256 characters without a call.

## Native Workers Rate Limiting (osn-api, behind Cloudflare)

osn-api runs on Cloudflare Workers. Its **one-minute limiters** run on the **Cloudflare Workers native Rate Limiting binding** (the GA `[[ratelimits]]` binding): atomic enforcement at the edge, with no store call on the hot path. The wrapper `createWorkersRateLimiter(binding)` lives in `@shared/rate-limit` (shared with cire-api) and satisfies the same `RateLimiterBackend` contract, so route call sites are unchanged and **fail-closed** (a binding throw → deny).

**Which backend each limiter runs on, deployed:**

| Limiter group | Backend | Why |
|---|---|---|
| One-minute per-IP auth limiters (register, login, passkey, step-up, session, security-event, passkey management, cross-device, recovery status and code entry, TOTP, OIDC) | **Native binding**, `RL_AUTH_IP_*` | Brute-force-facing throttles; the binding is atomic at the edge and costs no store call |
| Graph and organisation writes, recommendation suggest and search (per user) | **Native binding**, `RL_USER_20_60` / `RL_USER_60_60` | Search fires once per keystroke; a binding costs nothing per call |
| Profile create, delete and set-default, `GET /health/coordination`, the account export's per-IP guard and `GET /account/deletion-status` (per IP) | **Native binding**, the `RL_AUTH_IP_*` tiers under their own key prefix | One-minute windows |
| Hour-window per-IP auth limiters (`recoveryGenerate`, `recoveryComplete`, `recoveryEmailBegin`, `emailChangeBegin`, `oidcClientCreate`) | **Coordination store** | The native binding supports only `period` 10 or 60 s |
| Per-account caps (`profileSwitchCap`, `emailChangeBeginCap`, `recoveryEmailBeginCap`), the account export limiter (one a day per account) and the account deletion and restore limiters (per IP, an hour) | **Coordination store** | Windows of an hour or a day |

**Tiers + keying.** The native binding's `limit`/`period` live in `wrangler.toml`, so there is one binding per request-budget tier — `RL_AUTH_IP_{5,10,20,30,60}_60` per IP and `RL_USER_{20,60}_60` per user, each `simple = { limit, period = 60 }` — declared at top level **and mirrored into every named env** (named envs do NOT inherit top-level bindings). Each limiter maps to the tier whose limit is its budget. `selectAuthRateLimiters` keys an auth limiter `"<endpoint>:" + ip`, and `selectOsnLimiters` keys the others `"<store>:" + key` (`osn/api/src/lib/native-rate-limiters.ts`), so limiters sharing a tier never share a counter. Both run **once per isolate** (inside the per-isolate-cached `buildAll`), not per request. `osn/api/tests/lib/native-rate-limiters.test.ts` holds every `limit` in `wrangler.toml` to its budget.

**Per-colo trade-off (accepted).** Cloudflare counts native rate limits **per colo**, not globally. A single caller's requests reach one colo, so a per-IP limit holds. A user's devices can reach several, so a per-user limit can be looser than its budget by up to the number of colos in use; accepted, since no per-user limit guards a secret ([[coordination-store-on-durable-objects]]). The brute-force guards that matter — the lockout counters — are on the coordination store, which is global. The `namespace_id`s are account-scoped: production 2001–2007, staging 2201–2207, dev 2101–2107 — verify they're unused in the account at deploy.

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

Add the endpoint name to `AuthRateLimitedEndpoint` in [attrs.ts](../../shared/observability/src/metrics/attrs.ts). This is a bounded union -- no free-form strings allowed.

### Step 4: Write a route test

Send `maxRequests + 1` requests and assert the last returns 429.

## Current Limits

Every auth budget is set in `AUTH_RATE_LIMITS` (`osn/api/src/routes/auth/limiters.ts`), per IP; this is a summary of it.

| Budget | Auth limiters | Rationale |
|---|---|---|
| 5 / min | register begin, step-up OTP begin, TOTP enrolment begin, cross-device begin | Each sends mail or starts a ceremony that holds state — prevents email bombing |
| 10 / min | register complete, passkey register begin and complete, profile switch and list, emailed and TOTP recovery complete, recovery disown, step-up passkey begin and complete, step-up OTP and TOTP complete, TOTP enrolment complete and disable, session revoke, email change complete, security-event acknowledge, passkey delete, cross-device approve and reject, OIDC consent decision, connections revoke, client disable | Code and assertion checks — room for honest retries |
| 20 / min | passkey login complete, passkey rename, OIDC `/authorize` | A top-level navigation or a cheap settings write |
| 30 / min | handle check, recovery status, TOTP status, session list, security-event list, passkey list, OIDC connections list, client list | Cheap reads; the Security panel polls recovery status, and `@musubi/social`'s shell reads the security events once per load |
| 60 / min | passkey login begin, cross-device poll, OIDC `/authorize/context`, OIDC token | Fired automatically: conditional-UI autofill, 2 s polling, one call per consent screen, a relying party's server |
| 10 / hour | `/recovery/generate` | Flood control on a destructive action — each call burns the previous set |
| 5 / hour | `/login/recovery/complete`, `/login/recovery/email/begin`, OIDC client registration | Brute-force defence on the lost-device escape hatch; mail to the address on file; each registration mints a credential |
| 3 / hour | `/account/email/begin` | Each call mails a user-chosen address |

Graph write endpoints allow 60 requests per user per minute. Contact suggestions (`/recommendations/connections`) allow 20 requests per user per minute — tighter because each call runs an FOF fan-out query. People search (`/recommendations/search`) has its own counter, `recs.search`, at 60/user/min: the query is index-backed in the common case but fires once per debounced keystroke, so the suggestion budget would 429 a user mid-word. Both are per-user and fail-closed; the search cap is what bounds handle enumeration.

**What a search token buys.** The 60/min figure was sized when a people search was ~4 queries. It is now up to **7** — two edge-direction seeks for the caller's-connections pass, the handle-range seek, the optional infix scan, then the concurrent blocks / connection-state / shared-organisation probes — plus up to 4 for the organisation half, and the client now fires from the first keystroke rather than the second. Every added query is a bounded index seek (the caller's-edges pass is capped at 50 rows per direction, the candidate set peaks near 160 ids), and the query *count* is capped independently of query length by `MAX_QUERY_TOKENS`. Recorded rather than re-tuned: the budget still bounds request volume, but the next revision of it should start from 7, not 4. See [[social-graph]] §Search.

### Zap (`@zap/api`)

Zap applies the same per-IP fixed-window limiter to its write endpoints
(`createDefaultZapRateLimiters` in `zap/api/src/routes/chats.ts`):
`POST /chats` 20/min, `POST /chats/:id/messages` 60/min,
`POST /chats/:id/members` 30/min. These sit in front of ES256/JWKS token
verification and the social-graph consent gate — see [[zap]]. The limiter
check runs first so an unauthenticated flood is shed before any crypto or S2S
work.

### Pulse Per-User Write Limits (W4)

`@pulse/api` applies **per-user** fixed-window limiting to every authenticated write endpoint. The key is the JWT-asserted `claims.profileId`, **not** the client IP — so the Pulse write layer has no dependency on the `X-Forwarded-For` trust model that gates the unauthenticated reads. Limits live in one place (`pulse/api/src/lib/rate-limit.ts`, `PULSE_WRITE_LIMITS`), which every builder reads.

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

Pulse's limiters are in-memory only: both entries, the Bun server (`pulse/api/src/local.ts`) and the Workers `index.ts`, build them with `makeMemoryRateLimiters()` from `pulse/api/src/lib/rate-limit.ts`. Each process, and each Worker isolate, counts on its own, and a restart resets the counts. A refused hit is not counted, and a limiter sweeps expired keys once it holds more than 10,000.

### Pulse Per-IP Read / Share Limits (W4 / P4)

The **unauthenticated** Pulse surfaces — `GET /events/discover`, `POST /events/:id/share`, `POST /events/:id/exposure` — are limited **per IP** (discover 60/min, share 60/min, exposure 120/min; the exposure ceiling is higher because legitimate page reloads, link previews, and bot scans of a sourced URL all register there). `getClientIp(headers, options)` resolves the keying IP under its spoofing-resistant trust policy (`PULSE_TRUSTED_PROXY_COUNT`, or `trustCloudflare` behind CF; `socketIp` wired from Bun's `server.requestIP` in direct mode). An **unresolved IP fails closed** (429) via `isUnresolvedIp` rather than sharing a single `unknown` bucket — see [[#Client-IP Trust Policy]]. The budgets are `PULSE_IP_LIMITS` in `pulse/api/src/lib/rate-limit.ts`, which the routes' default limiters read too, with the OIDC sign-in legs beside them (20/min for `/api/auth/oidc/start` and `/callback`, 120/min for the session probe and sign-out). A deferred follow-up will bind these pings to an HMAC-signed share token so the counters cannot be inflated by a caller who simply replays the endpoint with a fresh IP.

## Config

```typescript
interface RateLimiterConfig {
  maxRequests: number;     // requests allowed per window
  windowMs: number;        // window duration in milliseconds
  maxEntries?: number;     // max distinct keys before expired-entry sweep (default: 10_000)
}
```

## Dependency Injection

Rate limiters are injected into route factories via a typed `AuthRateLimiters` object (declared `Readonly`). Routes accept injected limiter instances for testability -- tests can provide custom limiters with different configs or mock backends.

The `RateLimiterBackend` interface abstracts the storage backend:

```typescript
interface RateLimiterBackend {
  check(key: string): boolean | Promise<boolean>;
}
```

The abstraction is what lets a deployed Worker put each limiter on a native binding or the [[coordination-store]] without touching route code.

## Fail-Closed Posture

If the rate limiter backend throws (a native binding that throws, a coordination-store call that fails), the check defaults to `false` (deny). This is the fail-closed posture -- an unresponsive backend blocks requests rather than allowing unlimited throughput. We added the try/catch wrapping because async `check()` rejections surfaced as 500 errors instead of 429s.

## Proactive Sweep

The limiter evicts expired entries on every `check()` call when at least one window has passed since the last sweep. The `maxEntries` cap is a hard backstop; periodic sweeping keeps memory deterministic under normal load.

## Client-IP Trust Policy

`getClientIp(headers, options?)` in `@shared/rate-limit` resolves the keying IP under an explicit, **fail-closed** trust policy. Resolution order:

1. `trustCloudflare: true` → trust `cf-connecting-ip` only. Never falls back to `x-forwarded-for` (Cloudflare also sets XFF, but an attacker upstream of CF could pollute it). Missing/invalid → `UNRESOLVED_IP`.
2. `trustedProxyCount: N` (N > 0) → take the entry **N from the right** of `x-forwarded-for`. The right-most entry is the one the closest trusted proxy appended and is the only entry a client cannot forge — counting from the right is the only spoofing-resistant strategy. Chain missing / shorter than N / selected entry malformed → `UNRESOLVED_IP`.
3. otherwise (direct / dev) → trust the transport **socket peer** (`socketIp`, e.g. Bun `server.requestIP(request)?.address`) only; absent/invalid → `UNRESOLVED_IP`.

`isUnresolvedIp(ip)` reports the sentinel; `isValidIp(value)` is a cheap shape-only guard. **Callers MUST deny (429) on an unresolved IP** rather than rate-limiting on it — a shared "unknown" bucket is both a DoS amplifier (one attacker drains everyone's budget) and a spoofing bypass.

**Backward compatibility:** the no-options form `getClientIp(headers)` is `@deprecated` but preserved — it keeps the legacy left-most-XFF / `"unknown"` behaviour so un-migrated services still build. Hardening is opt-in per service via the options argument.

> **Fixed 2026-07-03.** The last residual call site,
> `osn/api/src/routes/account-erasure.ts`, now threads `clientIpConfig` from
> `app.ts` and keys via `getClientIp(headers, { ...clientIpConfig, socketIp })`
> with the `isUnresolvedIp` → 429 deny, matching the auth + profile routes.
> No deprecated no-args `getClientIp(headers)` call remains in `osn/api`
> (`pulse/api`'s public venue limiter still uses it; its own hardening is
> tracked separately).

**`@osn/api` wiring (now behind Cloudflare):** osn-api is deployed on Cloudflare Workers serving `id.musubi.social`, so every **non-local** tier now keys per-IP rate limiting on `cf-connecting-ip` **exclusively** (`trustCloudflare: true`), closing the XFF-spoof bypass. The Workers entry (`osn/api/src/index.ts` `buildAll`) sets `trustCloudflare: isNonLocal(env)`; `buildAppDeps` (`build-deps.ts`) then builds `clientIpConfig = { trustCloudflare: true }` for deployed tiers. `TRUSTED_PROXY_COUNT` is **ignored** in deployed tiers (it only feeds the legacy XFF/socket path on the local Bun dev server, where `trustCloudflare` is `false` and the per-request `socketIp` comes from Bun's `server.requestIP`). Under Cloudflare, the W3.3 startup warning about the proxy count stays suppressed. Unresolved IPs still deny (429) at the call sites via `isUnresolvedIp`. Pulse / Zap still use their own options; Cire is CF-aware in its own surface.

## Integration Notes — adopting the hardened policy

A consuming service migrates off the deprecated default by:

1. Deciding its edge topology and passing the matching option to `getClientIp`: `{ trustCloudflare: true }` behind Cloudflare, or `{ trustedProxyCount: N }` behind N trusted proxies (wire `socketIp` from the runtime's socket peer for direct/Bun deployments).
2. Treating `isUnresolvedIp(ip) === true` as **deny**, not as a bucket key.

- **Pulse** (`pulse/api/src/routes/{events,onboarding,venues}.ts`) and **Zap** (`zap/api/src/routes/chats.ts`) call `getClientIp(headers)` with no options today and run on Bun behind whatever proxy the deployment fronts them with — they adopt `{ trustedProxyCount: N }` (+ `socketIp`) when their own hardening workstreams land.
- **Cire** runs on Cloudflare Workers and has its own `cire/api/src/lib/client-ip.ts` (CF-aware already); when it consolidates onto `@shared/rate-limit` it passes `{ trustCloudflare: true }`.

## Known Limitations

- **`X-Forwarded-For` trust is now policy-gated** -- see Client-IP Trust Policy above. The residual caveat is operational: each service must declare its proxy topology (`TRUSTED_PROXY_COUNT` for `@osn/api`) or it falls back to socket-peer / unresolved-deny.
- **Fixed window** -- a burst at the window boundary can allow 2x the limit. Acceptable for auth endpoints; sliding window is overkill for current traffic.
- **In-memory on the Bun dev server** -- osn-api's Bun entry, and every Pulse entry, keep limits in process memory: process-local, reset on restart. A deployed osn-api never falls back to them; it answers 503 without its bindings.
- **Per-colo native counting** -- a per-user native limit can be looser than its budget for a user whose devices reach several colos (above).

## Security Finding History

| Status | Description |
| -------- | ------------- |
| Fixed | Rate limit all auth endpoints (per-IP fixed-window) |
| Fixed | `/handle/:handle` rate limited at 10 req/IP/min |
| Fixed | In-memory rate limiter resets on restart -- deployed tiers count on native bindings and the coordination store |
| Fixed | Trusted `X-Forwarded-For` without a reverse-proxy guarantee. `getClientIp` now takes a fail-closed `ClientIpOptions` trust policy (`trustCloudflare` / `trustedProxyCount` / `socketIp`); unresolved IPs are denied, not bucketed. `@osn/api` opts in via `TRUSTED_PROXY_COUNT`. Legacy no-options form kept `@deprecated` for incremental rollout. |
| Fixed | Async backend rejection was fail-open (now fail-closed) |
| Fixed | Graph rate-limit store grew without bound (now uses shared limiter) |
| Fixed | Auth rate limiter Maps swept proactively |

## Source Files

- [shared/rate-limit/src/](../../shared/rate-limit/src/) — `RateLimiterBackend` interface + in-memory implementation + `getClientIp` + `createWorkersRateLimiter`
- [shared/coordination/src/client.ts](../../shared/coordination/src/client.ts) — `createCoordinationRateLimiter()`, the fixed-window limiter on the coordination store
- [osn/api/src/lib/coordination/](../../osn/api/src/lib/coordination/) — the in-memory and durable bundles every osn-api limiter comes from
- [osn/api/src/lib/native-rate-limiters.ts](../../osn/api/src/lib/native-rate-limiters.ts) — `selectAuthRateLimiters`, `selectOsnLimiters` (native binding routing for the one-minute limiters)
- [osn/api/wrangler.toml](../../osn/api/wrangler.toml) — `[[ratelimits]]` tier bindings + `[observability]` (mirrored into every named env)
- [osn/api/src/routes/auth/limiters.ts](../../osn/api/src/routes/auth/limiters.ts) — `AUTH_RATE_LIMITS`, `OSN_RATE_LIMITS`: every osn-api budget
- [osn/api/src/routes/graph.ts](../../osn/api/src/routes/graph.ts) — graph route rate limiting
- [osn/api/src/metrics.ts](../../osn/api/src/metrics.ts) — `osn.auth.rate_limited` metric
- [osn/api/src/index.ts](../../osn/api/src/index.ts) — Workers entry: the durable bundle, the native bindings, the 503 on a missing one
- [shared/observability/src/metrics/attrs.ts](../../shared/observability/src/metrics/attrs.ts) — `AuthRateLimitedEndpoint` type
- [pulse/api/src/lib/rate-limit.ts](../../pulse/api/src/lib/rate-limit.ts) — `PULSE_WRITE_LIMITS`, `PULSE_IP_LIMITS`, `makeMemoryRateLimiters`, `checkWriteRateLimit` (W4)
- [pulse/api/src/routes/events.ts](../../pulse/api/src/routes/events.ts) — per-IP discover/share/exposure limiting + `getClientIp` trust policy (P4)
