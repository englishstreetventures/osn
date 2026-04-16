---
title: Rate Limit Incident
description: Runbook for investigating rate limiting incidents affecting legitimate users
tags: [runbook, auth, rate-limiting, incident]
severity: medium
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

Current limits (defined in `osn/core/src/routes/auth.ts`):

| Endpoint Group | Max req/IP/min | Purpose |
|----------------|----------------|---------|
| `/register/begin`, `/otp/begin`, `/magic/begin`, `/login/otp/begin`, `/login/magic/begin` | 5 | OTP/email send -- prevents email bombing |
| `/register/complete`, `/otp/complete`, `/magic/verify`, `/login/otp/complete`, `/login/passkey/begin`, `/login/passkey/complete`, `/passkey/register/begin`, `/passkey/register/complete`, `/handle/:handle` | 10 | Verify/complete -- higher to allow retries |

### 3. Check X-Forwarded-For Header Trust

The rate limiter uses `getClientIp(headers)` which reads `X-Forwarded-For`. Without a trusted reverse proxy, clients can spoof this header.

- **If behind a proxy**: verify the proxy is setting `X-Forwarded-For` correctly
- **If NOT behind a proxy**: the raw client IP is used, which is correct
- **Known issue (S-M34)**: there is no `trustProxy` configuration flag yet. The limiter trusts `X-Forwarded-For` unconditionally

### 4. Check for Coordinated Attack

If many IPs are hitting rate limits simultaneously:

- Check if the requests are automated (consistent timing, same user-agent)
- Check if the target endpoints suggest credential stuffing or enumeration
- Consider temporarily tightening limits or adding IP-range blocks at the infrastructure level

## Common Causes

| Cause | Signs | Resolution |
|-------|-------|------------|
| Shared IP (NAT/corporate) | Single IP, many legitimate users | Consider user-ID-based limiting for authenticated endpoints; accept the trade-off for unauthenticated endpoints |
| Misconfigured proxy headers (S-M34) | `X-Forwarded-For` is missing or wrong | Fix proxy configuration; add `trustProxy` flag when implemented |
| Redis failover (future) | Rate limits reset unexpectedly or all requests pass | Check Redis connectivity; the in-memory fallback should activate |
| Aggressive client retry | Single user hitting limits rapidly | Check client-side retry logic; add exponential backoff |
| Fixed-window boundary burst | Brief spike of 2x normal rate at window boundary | Known limitation of fixed-window algorithm; not actionable unless switching to sliding window |

## Mitigation

### Immediate

- If a legitimate user/IP is blocked, the rate limit window is 1 minute -- they can retry after waiting
- There is no manual override to clear rate limit state (it is in-memory)
- Restarting the `@osn/api` process clears all rate limit state (in-memory store resets)

### Short-term

- Adjust `maxRequests` values in the limiter configuration if limits are too aggressive
- Each limiter is independent, so you can tune per-endpoint

### Long-term

- **S-M2**: migrate to a shared counter (Redis / Cloudflare Durable Objects) for horizontal scaling
- **S-M34**: add a `trustProxy` configuration flag to control `X-Forwarded-For` trust
- Consider sliding-window algorithm if boundary bursts become a real problem

## Known Limitations

- **In-memory only**: rate limit state resets on process restart. Not safe for multi-process deployments
- **Trusts `X-Forwarded-For` unconditionally**: clients can spoof without a trusted reverse proxy
- **Fixed window**: a burst at the window boundary can allow 2x the configured limit
- **Proactive sweep**: expired entries are evicted on every `check()` call. The `maxEntries` cap (default 10,000) is a hard backstop

## Related

- [[rate-limiting]] -- full rate limiting architecture
- [[redis]] -- future shared state backend
- [[osn-core]] -- OSN Core architecture
