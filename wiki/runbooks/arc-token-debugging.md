---
title: ARC Token Debugging
description: Runbook for diagnosing ARC token authentication failures in service-to-service calls
tags: [runbook, auth, arc, s2s, incident]
severity: medium
---

# ARC Token Debugging Runbook

## Overview

ARC (ASAP-style) tokens are OSN's service-to-service authentication mechanism. They are ES256 (ECDSA P-256) self-issued JWTs used for backend-to-backend calls (e.g. Pulse API querying OSN Core's social graph over HTTP).

ARC tokens are **not** used for user-facing auth (that uses user JWTs) or for direct package imports (no network call, no token needed).

## Symptoms

- 401 responses on `/graph/internal/*` endpoints
- `"unknown_issuer"` spike in the `arc.token.verification` metric
- `arc.token.verification` errors in logs with tags like `expired`, `bad_signature`, `scope_denied`, `audience_mismatch`
- Service-to-service calls failing silently

## Diagnosis Steps

### 1. Check Service Registration

Every first-party service must have a row in the `service_accounts` table:

```sql
SELECT service_id, allowed_scopes, created_at
FROM service_accounts
WHERE service_id = '<issuer-service-id>';
```

If no row exists, the token will fail with `unknown_issuer`.

**Fix:** Register the service:

```sql
INSERT INTO service_accounts (service_id, public_key_jwk, allowed_scopes)
VALUES ('<service-id>', '<exported-public-key-jwk>', '<scopes>');
```

### 2. Verify Key Pair Matches

The service signs tokens with its private key. The `service_accounts` table must contain the matching public key.

Common failure: the key was rotated (new private key deployed) but the `public_key_jwk` in the database was not updated.

**Fix:**

1. Generate a new key pair: `generateArcKeyPair()`
2. Store the **private key** in the service's env/secret store
3. Update the **public key** in the database: `exportKeyToJwk(publicKey)`

```typescript
import { generateArcKeyPair, exportKeyToJwk } from "@osn/crypto/arc";

const keyPair = await generateArcKeyPair();
const publicKeyJwk = await exportKeyToJwk(keyPair.publicKey);
// Update service_accounts SET public_key_jwk = publicKeyJwk WHERE service_id = '...';
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
| `iss` | Issuer -- the calling service's `service_id` | `"pulse-api"` |
| `aud` | Audience -- the target service | `"osn-core"` |
| `scope` | What the token is authorized to do | `"graph:read"` |

**Common failures:**

- `audience_mismatch`: the token's `aud` does not match the receiving service's expected audience
- `scope_denied`: the token's `scope` is not in the service's `allowed_scopes` in the database

**Fix:**
- Ensure the calling service sets `aud` to match the target service's expected audience value
- Ensure the service's `allowed_scopes` in `service_accounts` includes the required scope

### 5. Check Token Cache

`getOrCreateArcToken` caches tokens in memory. If the cache becomes stale (e.g. after a key rotation), clear it:

```typescript
import { clearTokenCache, clearPublicKeyCache } from "@osn/crypto/arc";

clearTokenCache();       // Issuer side: force new token generation
clearPublicKeyCache();   // Verifier side: force public key re-lookup
```

## Common Causes

| Cause | Metric Tag | Resolution |
|-------|------------|------------|
| Service not registered in `service_accounts` | `unknown_issuer` | Insert row with service_id, public_key_jwk, allowed_scopes |
| Key rotated without DB update | `bad_signature` | Update `public_key_jwk` in `service_accounts` |
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

- [[arc-tokens]] -- ARC token architecture and API reference
- [[s2s-patterns]] -- cross-service communication patterns
- [[osn-core]] -- OSN Core identity stack
