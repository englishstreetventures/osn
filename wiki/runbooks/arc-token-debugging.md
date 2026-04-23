---
title: ARC Token Debugging
description: Runbook for diagnosing ARC token authentication failures in service-to-service calls
tags: [runbook, auth, arc, s2s, incident]
severity: medium
related:
  - "[[arc-tokens]]"
  - "[[s2s-patterns]]"
  - "[[osn-core]]"
last-reviewed: 2026-04-23
---

# ARC Token Debugging Runbook

## Overview

ARC (ASAP-style) tokens are OSN's service-to-service authentication mechanism. They are ES256 (ECDSA P-256) self-issued JWTs used for backend-to-backend calls (e.g. `@pulse/api` querying `@osn/api`'s social graph over HTTP).

ARC tokens are **not** used for user-facing auth (that uses user JWTs).

## Symptoms

- 401 responses on `/graph/internal/*` endpoints
- `"unknown_issuer"` spike in the `arc.token.verification` metric
- `arc.token.verification` errors in logs with tags like `expired`, `bad_signature`, `scope_denied`, `audience_mismatch`
- Service-to-service calls failing silently

## Diagnosis Steps

### 1. Check Service Registration

Every first-party service must have a row in `service_accounts` (with allowed scopes) and at least one un-revoked, un-expired key in `service_account_keys`:

```sql
SELECT sa.service_id, sa.allowed_scopes, sak.key_id, sak.expires_at, sak.revoked_at
FROM service_accounts sa
LEFT JOIN service_account_keys sak ON sak.service_id = sa.service_id
WHERE sa.service_id = '<issuer-service-id>';
```

If no row exists, the token will fail with `unknown_issuer`.

The expected production path is **ephemeral key auto-rotation** via `startKeyRotation()` — the service registers itself on boot through `POST /graph/internal/register-service`. Manual `INSERT`s should only be needed in disaster recovery.

### 2. Verify Key Pair Matches

The service signs tokens with its private key. The matching public key must exist (and be un-revoked, un-expired) in `service_account_keys`. The header `kid` is the lookup key.

Common failure: the in-process signing key was replaced but the `register-service` POST that publishes the public counterpart never landed (network blip on rotation).

**Fix:**

1. Restart the service (`startKeyRotation()` re-registers on boot), or
2. Force a manual rotation by hitting `POST /graph/internal/register-service` directly with a freshly-generated keypair.

```typescript
import { generateArcKeyPair, exportKeyToJwk } from "@shared/crypto";

const keyPair = await generateArcKeyPair();
const publicKeyJwk = await exportKeyToJwk(keyPair.publicKey);
// POST /graph/internal/register-service { serviceId, keyId, publicKeyJwk, allowedScopes, expiresAt }
```

### 3. Check Token Expiry

ARC tokens have a **5-minute TTL** by default. The `getOrCreateArcToken` function caches tokens in memory and re-issues them 30 seconds before expiry.

**Clock skew** greater than 5 minutes between services will cause all tokens to appear expired.

**Diagnosis:**

- Decode the token payload and check `iat` (issued at) and `exp` (expiry) claims
- Compare against the current time on the receiving service
- Check for NTP sync issues between hosts

```bash
# Decode the JWT payload
echo "<token-payload>" | base64 -d | jq '.iat, .exp'
```

### 4. Check Scope and Audience Claims

ARC tokens include `scope` and `aud` (audience) claims that must match the receiver's expectations.

| Claim | Description | Example |
|-------|-------------|---------|
| `iss` | Issuer — the calling service's `service_id` | `"pulse-api"` |
| `aud` | Audience — the target service | `"osn-api"` |
| `scope` | What the token is authorised to do | `"graph:read"` |

**Common failures:**

- `audience_mismatch`: the token's `aud` does not match the receiving service's expected audience
- `scope_denied`: the token's `scope` is not in the service's `allowed_scopes` in the database

**Fix:**
- Ensure the calling service sets `aud` to match the target service's expected audience value
- Ensure the service's `allowed_scopes` in `service_accounts` includes the required scope

### 5. Check Token Cache

`getOrCreateArcToken` caches tokens in memory. If the cache becomes stale (e.g. after a key rotation), clear it:

```typescript
import { clearTokenCache, clearPublicKeyCache, evictPublicKeyCacheEntry } from "@shared/crypto";

clearTokenCache();              // Issuer side: force new token generation
clearPublicKeyCache();          // Verifier side: force every public key re-lookup
evictPublicKeyCacheEntry(kid);  // Verifier side: evict one kid (call on revoke)
```

## Common Causes

| Cause | Metric Tag | Resolution |
|-------|------------|------------|
| Service not registered in `service_accounts` | `unknown_issuer` | Restart so `startKeyRotation()` re-registers; verify `INTERNAL_SERVICE_SECRET` is set |
| Public key never published or revoked | `bad_signature` | Re-run `register-service`; clear receiver cache via `evictPublicKeyCacheEntry(kid)` |
| Clock skew > 5 minutes | `expired` | Sync clocks via NTP |
| Wrong audience in token | `audience_mismatch` | Fix `aud` parameter in `createArcToken` / `getOrCreateArcToken` call |
| Scope not in `allowed_scopes` | `scope_denied` | Update `allowed_scopes` in `service_accounts` or fix the requested scope |
| Token cache serving expired token | `expired` | Should not happen (re-issues 30s before expiry), but call `clearTokenCache()` |

## ARC Metric Reference

| Metric | Type | What It Tells You |
|--------|------|-------------------|
| `arc.token.issued` | Counter | Token generation rate (should be low due to caching) |
| `arc.token.verification` | Counter | Verification attempts with `result` attribute |

The `result` attribute on `arc.token.verification` uses the `ArcVerifyResult` bounded union:
`"ok"` | `"expired"` | `"bad_signature"` | `"unknown_issuer"` | `"scope_denied"` | `"audience_mismatch"`

## Related

- [[arc-tokens]] — ARC token architecture and API reference
- [[s2s-patterns]] — cross-service communication patterns
- [[osn-core]] — OSN Core identity stack
