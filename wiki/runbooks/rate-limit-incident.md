---
title: Rate Limit Incident
description: Runbook for investigating rate limiting incidents affecting legitimate users
tags: [runbook, auth, rate-limiting, incident]
severity: medium
related:
  - "[[rate-limiting]]"
  - "[[redis]]"
  - "[[osn-core]]"
last-reviewed: 2026-07-23
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

Current limits (defined in `osn/api/src/routes/auth/limiters.ts`, mapped to native Workers bindings in `osn/api/src/lib/native-rate-limiters.ts`, and bound at the composition root in `osn/api/src/index.ts`). See [[rate-limiting]] for the canonical table — the abbreviated view, with the window stated per row:

| Endpoint group | Limit | Purpose |
|----------------|-------|---------|
| `/register/begin`, `/step-up/otp/begin` | 5 / IP / min | OTP / email send — prevents email bombing |
| `/register/complete`, `/login/passkey/complete`, `/passkey/register/{begin,complete}`, `/step-up/{passkey,otp}/complete`, `/account/email/complete` | 10–20 / IP / min | Verify / complete — higher to allow retries |
| `/login/passkey/begin`, `/handle/:handle` | 30–60 / IP / min | Fired by conditional-UI autofill and by as-you-type handle checks |
| `PATCH /passkeys/:id` (rename) | 20 / min | Cheap settings action |
| `DELETE /passkeys/:id` | 10 / min | Step-up is the primary gate; the throttle is defence in depth |
| `GET /passkeys` | 30 / min | Settings listing — cheap reads |
| `/login/recovery/complete` | 5 / IP / hour | Brute-force defence on the lost-device escape hatch |
| `/account/email/begin` | hourly window | Caps email-change OTPs |
| `POST /recovery/generate` | 1 / day (recoveryGenerate) | Stop-gap for S-M1 |

The 60-second per-IP windows run on **native Workers rate-limit bindings** in the deployed tiers. The hour- and day-window limiters stay on Upstash, because the native binding supports only a 10- or 60-second `period`.

### 3. Check Client-IP Trust Policy (S-M34)

The rate limiter resolves the keying IP with `getClientIp(headers, clientIpConfig)` under a **fail-closed** trust policy (see [[rate-limiting]] → Client-IP Trust Policy). Which branch applies depends on the runtime:

- **Deployed tiers (Workers) — `trustCloudflare`**: `osn/api/src/index.ts` sets `trustCloudflare: isNonLocal(env)`, so dev, staging and production all key off `cf-connecting-ip` and ignore both `X-Forwarded-For` and `TRUSTED_PROXY_COUNT`. A missing `cf-connecting-ip` fails closed (it never falls back to XFF). Check this branch first for any production incident.
- **Bun dev server only — `TRUSTED_PROXY_COUNT`**: the `osn/api/src/local.ts` entry drives the policy from `TRUSTED_PROXY_COUNT`. Unset or 0 (direct mode) takes the IP from the Bun socket peer (`server.requestIP`) and logs the startup warning `TRUSTED_PROXY_COUNT is unset`. `N` (proxy mode) takes the IP N entries from the **right** of `X-Forwarded-For`, so an N above the real hop count picks a shared proxy IP.
- **Unresolved IP → deny**: the policy denies a request whose IP it cannot resolve (no `cf-connecting-ip` behind CF, no XFF under a proxy, chain shorter than N, malformed entry, no socket peer) with 429 by design, rather than sharing an "unknown" bucket. A spike of 429s with no obvious abuser may mean the policy is mis-set — behind Cloudflare, check that requests really reach the Worker through the CF edge.

### 4. Check Backend Health (native binding vs Upstash vs in-memory)

Three backends are in play. Check the metric `osn.auth.rate_limited` plus the `redis.command.errors` counter to tell them apart:

- **Native Workers bindings** (deployed tiers, the 60s per-IP auth limiters) — enforced at the edge, with no Upstash round trip, so an Upstash outage cannot affect them. Cloudflare counts these **per colo**, not globally, so a caller spread across colos sees a slightly looser effective cap ([[rate-limiting]]).
- **Upstash-backed limiters** (the hour and day windows, and every per-user limiter) → individual `check()` calls **fail closed** (deny). A spike of 429s correlated with Upstash errors → restore Upstash. Do not flip the checks to fail-open.
- **In-memory fallback** (local dev, or a deployed tier where a tier binding is absent and `REDIS_URL` is unset) → process restarts wipe state, and each isolate keeps its own counters.

### 5. Check for Coordinated Attack

If many IPs are hitting rate limits simultaneously:

- Check whether the requests are automated (consistent timing, same user-agent)
- Check whether the target endpoints suggest credential stuffing or enumeration
- Consider tighter limits for a while, or IP-range blocks at the infrastructure level

## Common Causes

| Cause | Signs | Resolution |
|-------|-------|------------|
| Shared IP (NAT/corporate) | Single IP, many legitimate users | Consider user-ID-based limiting for authenticated endpoints; accept the trade-off for unauthenticated endpoints |
| Mis-set proxy trust (S-M34) | Mass 429s; on Workers a missing `cf-connecting-ip`; on the Bun dev server the startup warning `TRUSTED_PROXY_COUNT is unset`, or an N that doesn't match the real hop count | Behind Cloudflare, confirm traffic reaches the Worker through the CF edge. On the Bun dev server, set `TRUSTED_PROXY_COUNT` to the actual number of trusted proxies and verify the proxy emits `X-Forwarded-For` |
| Upstash outage (fail-closed) | Spike of 429s correlated with `redis.command.errors` | Do **not** flip individual checks to fail-open. Restore Upstash |
| Aggressive client retry | Single user hits limits fast | Check client-side retry logic. Add exponential backoff |
| Fixed-window boundary burst | Brief spike of 2x normal rate at window boundary | Known limit of the fixed-window algorithm. No action unless we move to a sliding window |

## Mitigation

### Immediate

- If a legitimate user or IP is blocked, the rate limit window is 1 minute — they can retry after that
- For Upstash-backed limiters, you can `DEL` the relevant `rl:{namespace}:{key}` to clear state for one IP
- Native binding counters have no manual override — wait out the 60-second window
- For the in-memory fallback there is no manual override either. Restart the local `@osn/api` process to reset its counters

### Short-term

- Adjust `maxRequests` values in the limiter configuration if the limits are too tight
- Each limiter is independent, so you can tune per-endpoint

### Long-term

- **S-M34 (done)**: `getClientIp` now takes a fail-closed `ClientIpOptions` trust policy; `@osn/api` sets `trustCloudflare` in every deployed tier and consults `TRUSTED_PROXY_COUNT` only on the Bun dev path. Pulse/Zap/Cire adopt the options in their own workstreams.
- Consider a sliding-window algorithm if boundary bursts become a problem

## Known Limitations

- **`X-Forwarded-For` trust is policy-gated** (S-M34, fixed): trust is opt-in through `ClientIpOptions` and fails closed. The remaining caveat is operational — each service must declare its topology (`trustCloudflare` on Workers, `TRUSTED_PROXY_COUNT` on the Bun dev path) or fall back to socket-peer / unresolved-deny.
- **Fixed window**: a burst at the window boundary can allow 2x the configured limit
- **Per-colo counting**: native binding limits are counted per colo, not globally — accepted, see [[rate-limiting]]
- **In-memory fallback**: with no native binding and no `REDIS_URL`, state is process-local and resets on restart — by design for local dev

## Related

- [[rate-limiting]] — full rate limiting architecture
- [[redis]] — Upstash backend (current production wiring)
- [[osn-core]] — OSN identity stack overview
