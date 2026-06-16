---
"@zap/api": minor
---

Harden Zap auth and authorization.

W1 (token verification): replace the HS256 shared-secret JWT check with
ES256/JWKS verification via `@shared/osn-auth-client` (audience `osn-access`,
inline per-handler). `OSN_JWT_SECRET` is gone. A single chokepoint
(AUDIT-Z2) rejects any verified `sub` that is not a `usr_` id so a non-user
principal can never be written into `created_by_profile_id` /
`sender_profile_id`. Boot fails fast if the JWKS URL is plaintext HTTP in a
non-local environment.

W2 (authorization & consent): pulling a profile into a chat now requires a
permitted OSN social-graph relationship, checked over an ARC-authenticated
Zap to OSN bridge (`/graph/internal/connection-status`, scope `graph:read`)
and failing closed (reject + `blocked` denial metric) when the graph is
unreachable. DMs are pinned to exactly two members; the last admin of a chat
can no longer be removed; message-list cursors are scoped to their chat and
unknown cursors are rejected instead of silently returning page 1. CORS is
restricted to a known-origin allowlist (`ZAP_CORS_ORIGIN`, fail-closed in
non-local envs) instead of reflecting any origin.

NOTE: requires `zap-api` to be provisioned as an ARC issuer in the OSN
`service_accounts` table (allowed scope `graph:read`); in local dev this is
done via self-registration with `INTERNAL_SERVICE_SECRET`.
