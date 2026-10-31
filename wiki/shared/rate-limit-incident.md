---
title: Rate Limit Incident
description: Runbook for investigating rate limiting incidents affecting legitimate users
tags: [runbook, auth, rate-limiting, incident]
severity: medium
related:
  - "[[rate-limiting]]"
  - "[[coordination-store]]"
  - "[[osn-core]]"
last-reviewed: 2026-10-27
---

# Rate Limit Incident Runbook

## Symptoms

- Legitimate users receive HTTP 429 responses
- Spike in the `osn.auth.rate_limited` metric
- Support reports of "can't log in" or "can't register"
- Many users on the same network affected at once

## Diagnosis

### 1. Determine Scope

Does this affect a single IP, or is it widespread?

- Check the `osn.auth.rate_limited` metric, broken down by endpoint
- If a single IP produces all the 429s, it is probably a shared IP (NAT, corporate network, VPN)
- If many different IPs are affected, the rate limit configuration may be too tight

### 2. Check Rate Limit Configuration

Current limits (defined once in `AUTH_RATE_LIMITS` and `OSN_RATE_LIMITS`, `osn/api/src/routes/auth/limiters.ts`; mapped to native Workers bindings in `osn/api/src/lib/native-rate-limiters.ts`). See [[rate-limiting]] for the full table — the abbreviated view, with the window stated per row:

| Endpoint group | Limit | Purpose |
|----------------|-------|---------|
| `/register/begin`, `/step-up/otp/begin` | 5 / IP / min | OTP / email send — prevents email bombing |
| `/register/complete`, `/passkey/register/{begin,complete}`, `/step-up/{passkey,otp}/complete`, `/account/email/complete` | 10 / IP / min | Verify / complete — room for retries |
| `/login/passkey/complete` | 20 / IP / min | Verify — needs a valid assertion |
| `/handle/:handle`, `/login/passkey/begin` | 30 and 60 / IP / min | Fired by as-you-type handle checks and conditional-UI autofill |
| `PATCH /passkeys/:id` (rename) | 20 / min | Cheap settings action |
| `DELETE /passkeys/:id` | 10 / min | Step-up is the primary gate; the throttle is defence in depth |
| `GET /passkeys` | 30 / min | Settings listing — cheap reads |
| `/login/recovery/complete` | 5 / IP / hour | Brute-force defence on the lost-device escape hatch |
| `/account/email/begin` | 3 / IP / hour | Caps email-change OTPs |
| `POST /recovery/generate` | 10 / IP / hour | Flood control: each call burns the previous set |

The one-minute windows run on **native Workers rate-limit bindings** in the deployed tiers. The hour- and day-window limiters — the per-account caps and the per-account export, deletion and restore limiters among them — run on the **coordination store** ([[coordination-store]]), because the native binding supports only a 10- or 60-second `period`.

### 3. Check Client-IP Trust Policy

The rate limiter resolves the keying IP with `getClientIp(headers, clientIpConfig)` under a **fail-closed** trust policy (see [[rate-limiting]] → Client-IP Trust Policy). Which branch applies depends on the runtime:

- **Deployed tiers (Workers) — `trustCloudflare`**: `osn/api/src/index.ts` sets `trustCloudflare: isNonLocal(env)`, so dev, staging and production all key off `cf-connecting-ip` and ignore both `X-Forwarded-For` and `TRUSTED_PROXY_COUNT`. A missing `cf-connecting-ip` fails closed (it never falls back to XFF). Check this branch first for any production incident.
- **Bun dev server only — `TRUSTED_PROXY_COUNT`**: the `osn/api/src/local.ts` entry drives the policy from `TRUSTED_PROXY_COUNT`. Unset or 0 (direct mode) takes the IP from the Bun socket peer (`server.requestIP`) and logs the startup warning `TRUSTED_PROXY_COUNT is unset`. `N` (proxy mode) takes the IP N entries from the **right** of `X-Forwarded-For`, so an N above the real hop count picks a shared proxy IP.
- **Unresolved IP → deny**: the policy denies a request whose IP it cannot resolve (no `cf-connecting-ip` behind CF, no XFF under a proxy, chain shorter than N, malformed entry, no socket peer) with 429 by design, rather than sharing an "unknown" bucket. A spike of 429s with no obvious abuser may mean the policy is mis-set — behind Cloudflare, check that requests really reach the Worker through the CF edge.

### 4. Check Backend Health (native binding vs coordination store vs in-memory)

Three backends are in play. Check the metric `osn.auth.rate_limited` plus osn-api's `coordination store call failed` log line to tell them apart:

- **Native Workers bindings** (deployed tiers: the one-minute per-IP auth limiters, and the per-user graph, organisation and recommendation limiters) — enforced at the edge, with no store call, so a coordination-store failure cannot affect them. Cloudflare counts these **per colo**, not globally, so a caller spread across colos sees a slightly looser effective cap ([[rate-limiting]]).
- **Coordination-store limiters** (the hour and day windows, the per-account caps, the per-account export, deletion and restore limiters) → a failed call **fails closed** (deny) and logs `coordination store call failed` with the store's name. A spike of 429s with those lines → the store is failing; `GET /health/coordination` answers 503 while it is. Do not flip the checks to fail-open. On dev, a spent Durable Object allowance looks the same until 00:00 UTC ([[free-tier-limits]]).
- **In-memory** (the Bun dev server) → process restarts wipe state. A deployed Worker never falls back to it: without `COORDINATION` or its `RL_USER_*` bindings it answers 503 on every route.

### 5. Check for Coordinated Attack

If many IPs are hitting rate limits simultaneously:

- Check whether the requests are automated (consistent timing, same user-agent)
- Check whether the target endpoints suggest credential stuffing or enumeration
- Consider tighter limits for a while, or IP-range blocks at the infrastructure level

## Common Causes

| Cause | Signs | Resolution |
|-------|-------|------------|
| Shared IP (NAT/corporate) | Single IP, many legitimate users | Consider user-ID-based limiting for authenticated endpoints; accept the trade-off for unauthenticated endpoints |
| Mis-set proxy trust | Mass 429s; on Workers a missing `cf-connecting-ip`; on the Bun dev server the startup warning `TRUSTED_PROXY_COUNT is unset`, or an N that doesn't match the real hop count | Behind Cloudflare, confirm traffic reaches the Worker through the CF edge. On the Bun dev server, set `TRUSTED_PROXY_COUNT` to the actual number of trusted proxies and verify the proxy emits `X-Forwarded-For` |
| Coordination-store failure (fail-closed) | Spike of 429s on hour-window endpoints with `coordination store call failed` in osn-api's logs | Do **not** flip individual checks to fail-open. Restore the store; on dev, wait for the 00:00 UTC reset |
| Aggressive client retry | Single user hits limits fast | Check client-side retry logic. Add exponential backoff |
| Fixed-window boundary burst | Brief spike of 2x normal rate at window boundary | Known limit of the fixed-window algorithm. No action unless we move to a sliding window |

## Mitigation

### Immediate

- If a legitimate user or IP is blocked, most windows are 1 minute — they can retry after that
- Coordination-store counters have no manual override: osn-api has no route that clears one. Wait out the window, an hour or a day
- Native binding counters have no manual override — wait out the 60-second window
- In-memory counters have no manual override either. Restart the local `@osn/api` process to reset them

### Short-term

- Adjust `maxRequests` values in the limiter configuration if the limits are too tight
- Each limiter is independent, so you can tune per-endpoint

### Long-term

- `getClientIp` now takes a fail-closed `ClientIpOptions` trust policy; `@osn/api` sets `trustCloudflare` in every deployed tier and consults `TRUSTED_PROXY_COUNT` only on the Bun dev path. Pulse/Zap/Cire adopt the options in their own workstreams.
- Consider a sliding-window algorithm if boundary bursts become a problem

## Known Limitations

- **`X-Forwarded-For` trust is policy-gated**: trust is opt-in through `ClientIpOptions` and fails closed. The remaining caveat is operational — each service must declare its topology (`trustCloudflare` on Workers, `TRUSTED_PROXY_COUNT` on the Bun dev path) or fall back to socket-peer / unresolved-deny.
- **Fixed window**: a burst at the window boundary can allow 2x the configured limit
- **Per-colo counting**: native binding limits are counted per colo, not globally — accepted, see [[rate-limiting]]
- **In-memory on the Bun dev server**: state is process-local and resets on restart — by design for local dev

## Related

- [[rate-limiting]] — full rate limiting architecture
- [[coordination-store]] — the Durable Object store behind the longer windows
- [[osn-core]] — OSN identity stack overview
