---
title: Session Management — List & Revoke
tags: [sessions, auth, copenhagen-book, device-management]
related:
  - "[[identity-model]]"
  - "[[recovery-codes]]"
  - "[[rate-limiting]]"
  - "[[arc-tokens]]"
packages:
  - "@osn/api"
  - "@osn/client"
  - "@osn/ui"
last-reviewed: 2026-04-18
---

# Session Management

User-facing surface that lets an account owner see which devices are signed in and sign any of them out. Built on top of the server-side session primitives in [[identity-model#server-side-sessions-copenhagen-book-c1]].

## Scope

Three endpoints, authenticated via Bearer access token:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/sessions`               | List every non-expired session for the caller's account |
| `DELETE` | `/sessions/:id`           | Revoke one session by hash id |
| `POST`   | `/sessions/revoke-others` | Revoke every session except the caller's |

The caller's HttpOnly session cookie is read alongside the Bearer token so the server can flag `is_current` on the matching row and distinguish `self` vs `other` revoke reasons. Missing cookie is fine — the list just won't flag the current device.

## Response shape

`GET /sessions`:

```json
{
  "sessions": [
    {
      "id": "a0b1c2…",               // sha256 of the session token (opaque handle)
      "created_at": 1_700_000_000,
      "last_seen_at": 1_700_001_000,
      "expires_at": 1_702_000_000,
      "user_agent": "Mozilla/5.0 …",
      "device_label": null,
      "ip_hash_prefix": "deadbeefdead", // 12 hex = 48-bit truncated fingerprint
      "created_ip_hash_prefix": null,
      "is_current": true
    }
  ]
}
```

The `id` is the sessions-table primary key — the SHA-256 of the raw session token. It is not a secret (it is a hash, not the token) but the route still only returns ids scoped to the authenticated account. The UI passes this back as the path segment on `DELETE /sessions/:id`.

## Revoke semantics

- **Per-session revoke** (`DELETE /sessions/:id`) — sessions that don't belong to the caller's account return `404 not_found`, same as "doesn't exist at all". There is no oracle that lets one account enumerate another's session ids. The endpoint emits `osn.auth.session.revoked{reason}` where `reason` is `"self"` when the hash matches the caller's cookie and `"other"` otherwise.

- **Revoke-others** (`POST /sessions/revoke-others`) — preserves the caller's current session (matched by cookie hash), deletes every other row for the account. Emits `osn.auth.session.revoked{reason="revoke_all_others"}`. If the caller has no cookie, the operation falls back to revoking every session on the account and logs a warning — callable only by the access-token bearer so this is still authenticated, just unusual.

- **Revoking the current device** is allowed; `was_current: true` in the response and the UI client invokes `onLoggedOut` to redirect to sign-in.

## Device metadata

Every issue-tokens / refresh-tokens call threads a `SessionContext` built by `resolveSessionContext(headers)`:

- `userAgent` — raw `User-Agent` header, capped at 512 chars.
- `ipHash` — `SHA-256(clientIp + OSN_IP_HASH_SALT)`. Coarse device fingerprint, not a security boundary; salt rotation invalidates historic equality, which is acceptable.
- `createdIpHash` — the `ip_hash` from the first session in the rotation family. Surfaced alongside the current `ip_hash_prefix` so "signed in from … currently active at …" can flag session-hijack patterns.

None of these travel in logs by default — `userAgent`, `ipHash`, `deviceLabel`, `createdIpHash` (and their snake_case variants) are all on the redaction deny-list.

## Rate limiting

| Endpoint | Cap | Rationale |
|----------|-----|-----------|
| `GET /sessions`              | 30 / min / IP | Users may refresh the settings page. |
| `DELETE /sessions/:id`       | 10 / min / IP | Tighter — a stolen access token shouldn't support mass revocation. |
| `POST /sessions/revoke-others` | 5 / min / IP | Strictest — a single call already revokes an unbounded number of rows. |

See [[rate-limiting]] for the shared backend (Redis when `REDIS_URL` is set, in-memory otherwise).

## Threat model

- **Stolen access token** can list sessions and revoke them. This is the same authority as any other Bearer-gated endpoint; step-up auth for destructive operations is tracked separately (M-PK follow-up).
- **Stolen session cookie** — list still works via the Bearer token; self-revoke kills only the stolen cookie's session if the attacker also holds the access token. Recovery-code login is the escape hatch for the "I've lost everything" case; see [[recovery-codes]].
- **Session enumeration across accounts** — prevented by the cross-account `SessionNotFoundError` path in `SessionService.revokeSession`. Both "doesn't exist" and "belongs to someone else" collapse to the same 404.

## Observability

- **Traces:** `auth.session.list`, `auth.session.revoke`, `auth.session.revoke_others` on the wrapper spans.
- **Metrics:**
  - `osn.auth.session.revoked{reason}` — unified counter, replaces the previous `osn.auth.session.security_invalidation`.
  - `osn.auth.session.listed` — no attrs, one inc per successful list.
  - `osn.auth.session.management_duration{action,result}` — histogram.
- **Logs:** `auth.session operation failed` on error paths; `Effect.logWarning` when `revokeOtherSessions` is called without a current session hash.

## Client & UI

- `createSessionsClient({ issuerUrl })` from `@osn/client` — narrow fetch wrapper (`listSessions`, `revokeSession`, `revokeOtherSessions`), no Effect in the public surface.
- `<SessionList client={…} accessToken={…} onLoggedOut={…} />` from `@osn/ui/auth` — the settings-panel surface. Optimistic refetch after each revoke; Kobalte `Dialog` for the destructive-action confirmation.

## Breaking changes shipped with this feature

1. `/token` `grant_type=refresh_token` is now **cookie-only** for first-party clients. The body-parameter fallback was removed. Third-party PKCE `authorization_code` grants still receive `refresh_token` in the body (spec-mandated).
2. `/logout` is **cookie-only**. The body `{ refresh_token }` parameter is gone.
3. `AccountSession.refreshToken` removed from `@osn/client` storage. Old blobs fail schema validation and are purged on load.
4. `osn.auth.session.security_invalidation{trigger}` **replaced by** `osn.auth.session.revoked{reason}` with a wider reason union. Dashboards should be updated.
5. `osn.auth.session.cookie_fallback` counter removed — no fallback left to count.
