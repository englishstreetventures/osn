---
title: S2S Migration
description: Runbook for migrating from direct package import to HTTP+ARC for service-to-service calls
tags: [runbook, s2s, arc, migration]
severity: low
status: planned
---

# S2S Migration Runbook

## Overview

This runbook covers the migration from direct package import to HTTP + ARC token authentication for service-to-service calls. This is **future work** -- currently Pulse imports `createGraphService()` from `@osn/core` directly with zero network overhead.

All cross-boundary calls go through `pulse/api/src/services/graphBridge.ts` -- see [[s2s-patterns]].

## When to Migrate

| Trigger | Action |
|---------|--------|
| Multi-process deployment | Migrate graphBridge to HTTP + ARC |
| Third-party app needs graph data | They use ARC tokens against `/graph/internal/*` |
| Horizontal scaling needed | Separate OSN Core and Pulse API processes |

## Current State

**Direct package import (current approach):**

```
@pulse/api
  └── imports createGraphService() from @osn/core
  └── imports @osn/db for Effect Layer
  └── Single file: pulse/api/src/services/graphBridge.ts
```

All cross-service calls are in-process function calls. No network, no tokens, no latency. This works because both run in the same Bun process.

## Future State

**HTTP + ARC tokens:**

```
@pulse/api
  └── HTTP call to @osn/app (port 4000)
      └── /graph/internal/* endpoints
      └── Authorization: ARC <token>
      └── ARC token signed by pulse-api's private key
      └── Verified by osn-core using pulse-api's public key from service_accounts
```

## Prerequisites

Before starting the migration:

1. **ARC verification middleware on internal routes**: `/graph/internal/*` endpoints must verify ARC tokens before processing requests. The middleware pattern is documented in [[arc-tokens]].

2. **Redis for rate limiting** (optional but recommended): if internal endpoints are rate-limited, the in-memory rate limiter will not work across processes. See [[rate-limiting]] for known limitations.

3. **Service account registration**: the calling service must be registered in the `service_accounts` table.

4. **Key pair generated and deployed**: private key in the calling service's environment, public key in the database.

5. **Observability wiring**: `instrumentedFetch` from `@shared/observability/fetch` must be used for all outbound HTTP to inject `traceparent` headers and preserve distributed traces.

## Migration Steps

### Step 1: Register the Service

Generate a key pair and register the calling service:

```typescript
import { generateArcKeyPair, exportKeyToJwk } from "@osn/crypto/arc";

const keyPair = await generateArcKeyPair();
const privateKeyJwk = await exportKeyToJwk(keyPair.privateKey);
const publicKeyJwk = await exportKeyToJwk(keyPair.publicKey);

// Store privateKeyJwk in env/secret store (e.g. ARC_PRIVATE_KEY_JWK)
```

Insert the public key into the database:

```sql
INSERT INTO service_accounts (service_id, public_key_jwk, allowed_scopes)
VALUES ('pulse-api', '<public-key-jwk>', 'graph:read');
```

### Step 2: Add ARC Middleware to Internal Routes

On the receiving service (`@osn/core`), add ARC verification to `/graph/internal/*` routes:

```typescript
import { verifyArcToken, resolvePublicKey } from "@osn/crypto/arc";

const arcMiddleware = (requiredScope: string) => async (ctx) => {
  const auth = ctx.headers.authorization;
  if (!auth?.startsWith("ARC ")) {
    ctx.set.status = 401;
    return { error: "missing_arc_token" };
  }

  const token = auth.slice(4);
  const publicKey = await Effect.runPromise(
    resolvePublicKey(/* iss */, [requiredScope]).pipe(Effect.provide(DbLive))
  );
  const claims = await verifyArcToken(token, publicKey, "osn-core", requiredScope);
  // claims.iss, claims.aud, claims.scope are now verified
};
```

### Step 3: Update graphBridge.ts

Replace direct imports with HTTP calls. This is the **single-file change** -- the entire point of the bridge pattern:

**Before (direct import):**

```typescript
import { createGraphService } from "@osn/core";

export const getConnectionIds = (userId: string) =>
  createGraphService().getConnections(userId);
```

**After (HTTP + ARC):**

```typescript
import { getOrCreateArcToken, importKeyFromJwk } from "@osn/crypto/arc";
import { instrumentedFetch } from "@shared/observability/fetch";

const privateKey = await importKeyFromJwk(process.env.ARC_PRIVATE_KEY_JWK!);

export const getConnectionIds = async (userId: string) => {
  const token = await getOrCreateArcToken(privateKey, {
    iss: "pulse-api",
    aud: "osn-core",
    scope: "graph:read",
  });

  const res = await instrumentedFetch(
    `http://localhost:4000/graph/internal/connections/${userId}`,
    { headers: { Authorization: `ARC ${token}` } }
  );

  if (!res.ok) {
    throw new GraphBridgeError({
      cause: `HTTP ${res.status}: ${await res.text()}`,
    });
  }

  return res.json();
};
```

### Step 4: Test

- Verify all graph bridge functions work via HTTP
- Check that ARC tokens are being cached (low `arc.token.issued` rate)
- Verify distributed traces link across services (check `traceparent` propagation)
- Run the full Pulse API test suite against the HTTP-backed bridge
- Verify rate limiting on internal endpoints works across processes

### Step 5: Clean Up

- Remove direct `@osn/core` and `@osn/db` imports from `pulse/api`
- Update workspace dependencies in `package.json`
- Add `@osn/crypto` as a dependency if not already present

## Validation Checklist

After migration, verify:

- [ ] All graph bridge functions return the same data as before
- [ ] ARC token caching works (no per-request key generation)
- [ ] Distributed traces show parent-child spans across services
- [ ] Rate limiting works across processes (requires Redis)
- [ ] Error mapping produces the same `GraphBridgeError` tags as before

## Rollback

Since `graphBridge.ts` is the single import surface, rollback is straightforward:

1. Revert `graphBridge.ts` to the direct import version
2. Restore `@osn/core` and `@osn/db` as workspace dependencies
3. Redeploy

## Related

- [[arc-tokens]] -- ARC token architecture, API, and verification
- [[s2s-patterns]] -- cross-service communication patterns and the graphBridge design
- [[arc-token-debugging]] -- troubleshooting ARC token issues
- [[redis]] -- shared state backend for multi-process rate limiting
