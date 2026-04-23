---
title: Rate Limit Incident
description: Runbook for investigating rate limiting incidents affecting legitimate users
tags: [runbook, auth, rate-limiting, incident]
severity: medium
related:
  - "[[rate-limiting]]"
  - "[[redis]]"
  - "[[osn-core]]"
last-reviewed: 2026-04-23
---

# Rate Limit Incident Runbook

## Symptoms

- Legitimate users receiving HTTP 429 responses
- Spike in the `osn.auth.rate_limited` metric
- Support reports of "can't log in" or "can't register"
- Multiple users affected simultaneously from the same network

## Diagnosis

### 1. Determine Scope

Is this affecting a single IP or is it widespread?

- Check the `osn.auth.rate_limited` metric, broken down by endpoint
- If a single IP is producing all 429s, it is likely a shared IP (NAT, corporate network, VPN)
- If many different IPs are affected, the rate limit configuration may be too aggressive

### 2. Check Rate Limit Configuration

Current limits (defined in `osn/api/src/routes/auth.ts` and bound at the composition root in `osn/api/src/index.ts`). See [[rate-limiting]] for the canonical table — the abbreviated view:

| Endpoint group | Max req/IP/min | Purpose |
|----------------|----------------|---------|
| `/register/begin`, `/step-up/otp/begin`, `/account/email/begin` | 5 | OTP / email send — prevents email bombing |
| `/register/complete`, `/login/passkey/begin`, `/login/passkey/complete`, `/login/recovery/complete` (5/hr), `/passkey/register/{begin,complete}`, `/step-up/{passkey,otp}/complete`, `/account/email/complete`, `/handle/:handle` | 10 | Verify / complete — higher to allow retries |
| `PATCH /passkeys/:id` (rename) | 20 | Cheap settings action |
| `DELETE /passkeys/:id` | 10 | Step-up is the primary gate; per-IP throttle is defence in depth |
| `GET /passkeys` | 30 | Settings listing — cheap reads |
| `POST /recovery/generate` | 1/day/IP (recoveryGenerate) | Stop-gap for S-M1 |

### 3. Check X-Forwarded-For Header Trust

The rate limiter uses `getClientIp(headers)` which reads `X-Forwarded-For`. Without a trusted reverse proxy, clients can spoof this header.

- **If behind a proxy**: verify the proxy is setting `X-Forwarded-For` correctly
- **If NOT behind a proxy**: the raw client IP is used, which is correct
- **Known issue (S-M34)**: there is no `trustProxy` configuration flag yet. The limiter trusts `X-Forwarded-For` unconditionally

### 4. Check Backend Health (Redis vs in-memory)

The rate limiter is Redis-backed when `REDIS_URL` is set, in-memory otherwise. Check the metric `osn.auth.rate_limited` plus the `redis.command.errors` counter to differentiate:

- **Redis backend down** → individual `check()` calls **fail closed** (deny). Spike of 429s correlated with Redis errors → restore Redis or temporarily switch to in-memory by unsetting `REDIS_URL` (single-process only — see [[rate-limiting]]).
- **In-memory only** → process restarts wipe state. A blue/green or rolling deploy briefly resets all counters; bursts immediately afterward look like a coordinated spike.

### 5. Check for Coordinated Attack

If many IPs are hitting rate limits simultaneously:

- Check if the requests are automated (consistent timing, same user-agent)
- Check if the target endpoints suggest credential stuffing or enumeration
- Consider temporarily tightening limits or adding IP-range blocks at the infrastructure level

## Common Causes

| Cause | Signs | Resolution |
|-------|-------|------------|
| Shared IP (NAT/corporate) | Single IP, many legitimate users | Consider user-ID-based limiting for authenticated endpoints; accept the trade-off for unauthenticated endpoints |
| Misconfigured proxy headers (S-M34) | `X-Forwarded-For` is missing or wrong | Fix proxy configuration; add `trustProxy` flag when implemented |
| Redis outage (fail-closed) | Spike of 429s correlated with `redis.command.errors` | Restore Redis; do **not** flip individual checks to fail-open |
| Aggressive client retry | Single user hitting limits rapidly | Check client-side retry logic; add exponential backoff |
| Fixed-window boundary burst | Brief spike of 2x normal rate at window boundary | Known limitation of fixed-window algorithm; not actionable unless switching to sliding window |

## Mitigation

### Immediate

- If a legitimate user/IP is blocked, the rate limit window is 1 minute — they can retry after waiting
- For Redis-backed limiters, you can `DEL` the relevant `rl:{namespace}:{key}` to clear state for one IP
- For in-memory fallback, there is no manual override; restarting `@osn/api` resets all in-memory counters

### Short-term

- Adjust `maxRequests` values in the limiter configuration if limits are too aggressive
- Each limiter is independent, so you can tune per-endpoint

### Long-term

- **S-M34**: add a `trustProxy` configuration flag to control `X-Forwarded-For` trust
- Consider sliding-window algorithm if boundary bursts become a real problem

## Known Limitations

- **Trusts `X-Forwarded-For` unconditionally** (S-M34): clients can spoof without a trusted reverse proxy
- **Fixed window**: a burst at the window boundary can allow 2x the configured limit
- **In-memory fallback**: when `REDIS_URL` is unset, state is process-local and resets on restart — by design for local dev

## Related

- [[rate-limiting]] — full rate limiting architecture
- [[redis]] — Redis backend (current production wiring)
- [[osn-core]] — OSN identity stack overview
