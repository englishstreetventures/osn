---
"@osn/api": minor
"@osn/client": minor
"@shared/observability": minor
---

feat(auth): server-authoritative `/me` endpoint + unified `requireAuth` derive

Adds `GET /me` to `@osn/api`: returns the authenticated profile, active profile
id, and granted scopes. Uses Bearer access-token auth (S-H1). Rate-limited at
60 req/IP/min.

Refactors `routes/profile.ts` and the `/profiles/switch` + `/profiles/list`
handlers to use a shared `requireAuth` helper in `lib/auth-derive.ts`,
collapsing ~25 lines of per-route duplication (closes S-M2).

**Client SDK breaking changes (no legacy accommodation):**
- `Session.refreshToken` is removed — the refresh token lives only in the
  HttpOnly cookie (Copenhagen Book C3). Callers no longer receive it in JS.
- `AccountSession.refreshToken` is removed from client-side storage for the
  same reason — closes an XSS exfiltration surface for the longest-lived
  credential.
- `extractJwtSub` is removed. The client no longer decodes the unverified
  access token to derive `activeProfileId`; instead it calls `GET /me` and
  trusts the server.
- New `OsnAuthService.me()` method — returns `{ profile, activeProfileId, scopes }`.
- `handleCallback`, `refreshSession`, and `setSession` now call `/me`
  internally to resolve the active profile id server-authoritatively.

Legacy `AccountSession` payloads in localStorage fail schema validation and
are wiped on next load, forcing a fresh cookie-backed login.

New metric: `osn.auth.me.requests` (counter, attrs `{ result: ok | unauthorized | rate_limited | error }`).
Adds `"me"` to `AuthRateLimitedEndpoint` in `@shared/observability`.
