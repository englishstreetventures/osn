# Provisioning `zap-api` as an OSN ARC issuer (production)

`@zap/api` calls the OSN social graph (`/graph/internal/connection-status`) over
ARC-authenticated S2S to gate chat consent (W2). Those calls **fail closed** until
`zap-api` is registered as an ARC issuer in OSN's `service_accounts` /
`service_account_keys` tables with the `graph:read` scope and audience `osn-api`.

In production we use a **stable, pre-distributed key** (not the local-dev
ephemeral self-registration path) — on Cloudflare Workers a fresh ephemeral key
per isolate would otherwise churn a new `service_account_keys` row each time.
`zapGraphBridge` loads the stable key from env when `ZAP_API_ARC_PRIVATE_KEY` +
`ZAP_API_ARC_KEY_ID` are set, and skips self-registration.

## Key identity (public — safe to commit)

- **serviceId:** `zap-api`
- **scope:** `graph:read`
- **audience:** `osn-api`
- **keyId (`kid`):** `bca36fe8-4f0e-4a44-aa2e-7099c3a37523`
- **public JWK (ES256 / P-256):**

  ```json
  {"crv":"P-256","kty":"EC","x":"K9imlG4kizdekY_cjET1fntqmVtiNrEu97rozjZLRKo","y":"yc7BpXZ8rfOl5NQqRBIFh6z_h9S02G12rnmOenO-_y8"}
  ```

> The matching **private JWK** is delivered out-of-band (never committed). Store it
> only in the `zap-api` production secret store.

## Step 1 — Set `zap-api` production secrets

```
ZAP_API_ARC_PRIVATE_KEY = <private JWK, delivered out-of-band>
ZAP_API_ARC_KEY_ID      = bca36fe8-4f0e-4a44-aa2e-7099c3a37523
OSN_API_URL             = https://<osn-api prod origin>   # must be https in prod
OSN_ENV                 = production
```

On Cloudflare Workers: `wrangler secret put ZAP_API_ARC_PRIVATE_KEY --env production`
(paste the JWK), and set the rest as `[env.production.vars]` / secrets.

## Step 2 — Register the public key with OSN (pick ONE)

### Option A — register-service endpoint (recommended; validates + upserts both tables)

Authenticated with the shared `INTERNAL_SERVICE_SECRET`. `expiresAt` is set far in
the future so the stable key doesn't expire (re-run to roll it):

```bash
curl -fsS -X POST "https://<osn-api prod origin>/graph/internal/register-service" \
  -H "authorization: Bearer $INTERNAL_SERVICE_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "serviceId": "zap-api",
    "keyId": "bca36fe8-4f0e-4a44-aa2e-7099c3a37523",
    "publicKeyJwk": "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"K9imlG4kizdekY_cjET1fntqmVtiNrEu97rozjZLRKo\",\"y\":\"yc7BpXZ8rfOl5NQqRBIFh6z_h9S02G12rnmOenO-_y8\"}",
    "allowedScopes": "graph:read",
    "expiresAt": 2097033557
  }'
```

### Option B — direct DB seed (if you prefer no shared secret; `expires_at` NULL = stable)

OSN identity DB. Times are Unix **seconds**. (`ON CONFLICT` works on SQLite/libsql
and Postgres.)

```sql
INSERT INTO service_accounts (service_id, allowed_scopes, created_at, updated_at)
VALUES ('zap-api', 'graph:read', strftime('%s','now'), strftime('%s','now'))
ON CONFLICT(service_id) DO UPDATE SET
  allowed_scopes = excluded.allowed_scopes,
  updated_at     = excluded.updated_at;

INSERT INTO service_account_keys (key_id, service_id, public_key_jwk, registered_at, expires_at, revoked_at)
VALUES (
  'bca36fe8-4f0e-4a44-aa2e-7099c3a37523',
  'zap-api',
  '{"crv":"P-256","kty":"EC","x":"K9imlG4kizdekY_cjET1fntqmVtiNrEu97rozjZLRKo","y":"yc7BpXZ8rfOl5NQqRBIFh6z_h9S02G12rnmOenO-_y8"}',
  strftime('%s','now'),
  NULL,
  NULL
)
ON CONFLICT(key_id) DO UPDATE SET
  public_key_jwk = excluded.public_key_jwk,
  expires_at     = excluded.expires_at,
  revoked_at     = NULL;
```

(Postgres: replace `strftime('%s','now')` with `extract(epoch from now())::int`.)

## Step 3 — Verify

After deploy, a Zap chat-create / add-member with two connected profiles should
succeed; with unconnected profiles it should reject (consent fail-closed). You can
also confirm OSN accepts the token directly:

```bash
# expect HTTP 200 (not 401) — proves the kid→issuer→scope binding resolves
curl -i "https://<osn-api prod origin>/graph/internal/connection-status?viewerId=usr_…&targetId=usr_…" \
  -H "authorization: ARC <token signed by zap-api with the stable key>"
```

## Rotation

To roll the key: generate a new ES256 pair, register the new `kid` (Option A/B),
update the two `zap-api` secrets, redeploy, then revoke the old key
(`UPDATE service_account_keys SET revoked_at = strftime('%s','now') WHERE key_id = '<old>'`).
ARC public-key cache TTL is ≤5 min (`ARC_PUBLIC_KEY_CACHE_TTL_SECONDS`), so revocation
takes effect within that window.

> **Follow-up:** `pulse-api` has the same stable-key gap (its bridge documents
> `PULSE_API_ARC_PRIVATE_KEY` but still only implements the ephemeral path) — worth
> mirroring this change before Pulse's S2S graph calls run on Workers at scale.
