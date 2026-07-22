---
title: Rate Limit Incident
description: Runbook for investigating rate limiting incidents affecting legitimate users
tags: [runbook, auth, rate-limiting, incident]
severity: medium
related:
  - "[[rate-limiting]]"
  - "[[redis]]"
  - "[[osn-core]]"
last-reviewed: 2026-07-22
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

Current limits (defined in `osn/api/src/routes/auth/limiters.ts` and bound at the composition root in `osn/api/src/index.ts`). See [[rate-limiting]] for the canonical table — the abbreviated view:

| Endpoint group | Max req/IP/min | Purpose |
|----------------|----------------|---------|
| `/register/begin`, `/step-up/otp/begin`, `/account/email/begin` | 5 | OTP / email send — prevents email bombing |
| `/register/complete`, `/login/passkey/begin`, `/login/passkey/complete`, `/login/recovery/complete` (5/hr), `/passkey/register/{begin,complete}`, `/step-up/{passkey,otp}/complete`, `/account/email/complete`, `/handle/:handle` | 10 | Verify / complete — higher to allow retries |
| `PATCH /passkeys/:id` (rename) | 20 | Cheap settings action |
| `DELETE /passkeys/:id` | 10 | Step-up is the primary gate; per-IP throttle is defence in depth |
| `GET /passkeys` | 30 | Settings listing — cheap reads |
| `POST /recovery/generate` | 1/day/IP (recoveryGenerate) | Stop-gap for S-M1 |

### 3. Check Client-IP Trust Policy (S-M34)

The rate limiter resolves the keying IP with `getClientIp(headers, clientIpConfig)` under a **fail-closed** trust policy (see [[rate-limiting]] → Client-IP Trust Policy). For `@osn/api` the `TRUSTED_PROXY_COUNT` env var drives the policy:

- **`TRUSTED_PROXY_COUNT` unset / 0 (direct mode)**: the IP comes from the Bun socket peer (`server.requestIP`), NOT `X-Forwarded-For`. Behind an *undeclared* reverse proxy or load balancer, every user shares the load balancer's IP → mass 429s. Look for the startup warning `TRUSTED_PROXY_COUNT is unset` in logs. Fix: set `TRUSTED_PROXY_COUNT` to the number of trusted hops.
- **`TRUSTED_PROXY_COUNT = N` (proxy mode)**: the policy takes the IP N entries from the **right** of `X-Forwarded-For`. If N is too high (more than the real hop count), the policy picks a shared proxy IP, or the entry resolves as malformed → spurious 429s. Verify that N matches the real proxy chain depth.
- **Unresolved IP → deny**: the policy denies a request whose IP it cannot resolve (no XFF under a proxy, chain shorter than N, malformed entry, no socket peer) with 429 by design, rather than sharing an "unknown" bucket. A spike of 429s with no obvious abuser may mean the policy is mis-set (e.g. the proxy does not send XFF) — reconcile `TRUSTED_PROXY_COUNT` with the deployment topology.
- **Cloudflare**: when fronted by CF, the policy uses `trustCloudflare` (`cf-connecting-ip`) instead; a missing `cf-connecting-ip` fails closed (never falls back to XFF).

### 4. Check Backend Health (Redis vs in-memory)

The rate limiter is Redis-backed when `REDIS_URL` is set, in-memory otherwise. Check the metric `osn.auth.rate_limited` plus the `redis.command.errors` counter to tell the two apart:

- **Redis backend down** → individual `check()` calls **fail closed** (deny). Spike of 429s correlated with Redis errors → restore Redis, or unset `REDIS_URL` to switch to in-memory for now (single-process only — see [[rate-limiting]]).
- **In-memory only** → process restarts wipe state. A blue/green or rolling deploy briefly resets all counters; bursts immediately afterward look like a coordinated spike.

### 5. Check for Coordinated Attack

If many IPs are hitting rate limits simultaneously:

- Check whether the requests are automated (consistent timing, same user-agent)
- Check whether the target endpoints suggest credential stuffing or enumeration
- Consider tighter limits for a while, or IP-range blocks at the infrastructure level

## Common Causes

| Cause | Signs | Resolution |
|-------|-------|------------|
| Shared IP (NAT/corporate) | Single IP, many legitimate users | Consider user-ID-based limiting for authenticated endpoints; accept the trade-off for unauthenticated endpoints |
| Mis-set proxy trust (S-M34) | Mass 429s; startup warning `TRUSTED_PROXY_COUNT is unset`, or N doesn't match the real hop count | Set `TRUSTED_PROXY_COUNT` to the actual number of trusted proxies (or `trustCloudflare` behind CF); verify the proxy actually emits `X-Forwarded-For` |
| Redis outage (fail-closed) | Spike of 429s correlated with `redis.command.errors` | Do **not** flip individual checks to fail-open. Restore Redis |
| Aggressive client retry | Single user hits limits fast | Check client-side retry logic. Add exponential backoff |
| Fixed-window boundary burst | Brief spike of 2x normal rate at window boundary | Known limit of the fixed-window algorithm. No action unless we move to a sliding window |

## Mitigation

### Immediate

- If a legitimate user or IP is blocked, the rate limit window is 1 minute — they can retry after that
- For Redis-backed limiters, you can `DEL` the relevant `rl:{namespace}:{key}` to clear state for one IP
- For the in-memory fallback there is no manual override. Restart `@osn/api` to reset all in-memory counters

### Short-term

- Adjust `maxRequests` values in the limiter configuration if the limits are too tight
- Each limiter is independent, so you can tune per-endpoint

### Long-term

- **S-M34 (done)**: `getClientIp` now takes a fail-closed `ClientIpOptions` trust policy; `@osn/api` drives it via `TRUSTED_PROXY_COUNT`. Ensure each deploy sets the correct hop count. Pulse/Zap/Cire adopt the options in their own workstreams.
- Consider a sliding-window algorithm if boundary bursts become a problem

## Known Limitations

- **`X-Forwarded-For` trust is policy-gated** (S-M34, fixed): trust is opt-in through `ClientIpOptions` and fails closed. The remaining caveat is operational — each service must declare its proxy topology (`TRUSTED_PROXY_COUNT` for `@osn/api`) or fall back to socket-peer / unresolved-deny.
- **Fixed window**: a burst at the window boundary can allow 2x the configured limit
- **In-memory fallback**: when `REDIS_URL` is unset, state is process-local and resets on restart — by design for local dev

## Related

- [[rate-limiting]] — full rate limiting architecture
- [[redis]] — Redis backend (current production wiring)
- [[osn-core]] — OSN identity stack overview
