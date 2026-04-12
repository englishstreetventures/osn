---
title: Auth Flow Failure
description: Runbook for diagnosing authentication failures across all auth methods
tags: [runbook, auth, incident]
severity: high
---

# Auth Flow Failure Runbook

## Symptoms

- 401 responses on `/login/*` endpoints
- OTP codes not arriving via email
- Passkey registration or login fails
- Magic link expired or invalid
- PKCE state mismatch errors
- Users unable to register or sign in

## Diagnosis Steps

### 1. Check Rate Limiting

Is the user's IP being rate-limited?

- Check the `osn.auth.rate_limited` metric for recent spikes
- Look at the endpoint breakdown in the metric attributes to identify which flow is blocked
- Current limits: 5 req/IP/min for begin endpoints (OTP/magic link send), 10 req/IP/min for complete/verify endpoints

If rate-limited, the response will be HTTP 429. See [[rate-limiting]] for full details on limits and configuration.

### 2. Check Auth Method

#### OTP

- Does the OTP store entry exist? OTP entries have a **10-minute TTL** and are deleted after successful verification
- Is the OTP code correct? Check for typos (codes are numeric)
- Has the user requested multiple OTPs? Only the most recent code is valid

#### Magic Link

- Is the magic link token still valid? Tokens expire after a configured TTL
- Has the link already been used? Magic link tokens are single-use
- Is the email delivery service operational? Check email provider logs

#### Passkey

- Is the passkey credential registered in the database? Check the `passkeys` table
- Is the WebAuthn challenge still valid? Challenges are short-lived
- Is the user's browser/webview compatible? Tauri webview passkey support varies by platform
- Check the `authenticatorData` and `clientDataJSON` for format issues

#### Refresh Token

- Is the JWT secret configured? Check `JWT_SECRET` or equivalent env var
- Is the token expired? Decode the JWT and check `exp` claim
- Does the token include the `handle` claim?

### 3. Check JWT Configuration

- Is the JWT signing secret set in the environment?
- Is the token expired? Check the `exp` claim against current time
- Does the token contain the required claims (`sub`, `handle`, `iat`, `exp`)?
- Is the `handle` claim present? Some flows depend on it

### 4. Check PKCE Flow (Third-party OAuth)

PKCE is used by the hosted `/authorize` page for third-party OAuth clients. First-party apps do not use PKCE.

- Does the `state` parameter match between the authorization request and callback?
- Is the `code_verifier` correct? It must match the `code_challenge` sent in the initial request
- Does the `redirect_uri` match the stored value exactly (including trailing slashes)?
- Is the authorization code still valid? Codes are short-lived and single-use

## Common Causes

| Cause | Symptom | Resolution |
|-------|---------|------------|
| Rate limit hit | 429 on login/register | Wait for window to expire (1 minute) or check if IP is shared (NAT/corporate) |
| OTP expired | "Invalid code" after 10+ minutes | Request a new OTP |
| Email delivery failure | OTP/magic link never arrives | Check email provider status, spam folders, delivery logs |
| Passkey not supported in Tauri webview | Registration/login silently fails | Check platform compatibility; fall back to OTP/magic link |
| PKCE state mismatch | "Invalid state" error on callback | Ensure state is preserved across the redirect (check session storage) |
| JWT secret missing | 500 on token creation | Set the JWT secret in environment variables |
| Clock skew | Token appears expired immediately | Sync server clocks; check for timezone issues |
| Multiple OTP requests | Earlier code rejected | Only the most recent OTP is valid; use the latest code |

## Useful Queries

### Check rate limit state

The rate limiter is in-memory, so state is lost on restart. Check the `osn.auth.rate_limited` metric in Grafana for historical data.

### Check user's passkey registrations

Query the `passkeys` table for the user's ID to see registered credentials.

### Decode a JWT

```bash
# Decode the payload (base64)
echo "<token-payload-section>" | base64 -d | jq .
```

## Related

- [[rate-limiting]] -- rate limit configuration and known limitations
- [[arc-tokens]] -- S2S auth (not used for user-facing auth)
- [[osn-core]] -- OSN Core architecture and auth flows
