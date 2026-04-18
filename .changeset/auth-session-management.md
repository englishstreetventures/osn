---
"@osn/api": minor
"@osn/client": minor
"@osn/ui": minor
"@osn/db": minor
"@shared/observability": patch
---

Ship user-facing session management (list + per-device revoke).

**New:**
- `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-others` endpoints on `@osn/api`, all Bearer-authenticated with dedicated rate limiters (30 / 10 / 5 per minute).
- `sessions` table gains device metadata columns (`user_agent`, `ip_hash`, `last_seen_at`, `created_ip_hash`, `device_label`), populated on every `issueTokens` / `refreshTokens` from a new `resolveSessionContext(headers)` helper in `osn/api/src/lib/auth-derive.ts`.
- `SessionService` in `osn/api/src/services/session.ts` — list / revoke-one / revoke-others with cross-account oracle-safe 404s.
- `createSessionsClient({ issuerUrl })` in `@osn/client` — narrow fetch wrapper, no Effect on the public surface.
- `<SessionList />` in `@osn/ui/auth` — settings-panel surface with current-device flag and destructive-action confirmation dialogs.
- Unified `osn.auth.session.revoked{reason}` counter covers every path that deletes a session row (self / other / revoke_all_others / logout / passkey_register / recovery_code_generate / recovery_code_consume), plus `osn.auth.session.listed` counter and `osn.auth.session.management_duration{action,result}` histogram.

**Breaking changes:**
- `/token` `grant_type=refresh_token` is now cookie-only for first-party clients. The `refresh_token` body parameter is no longer accepted. Third-party PKCE `authorization_code` grants still receive `refresh_token` in the body (spec-mandated).
- `/logout` is cookie-only. The body `{ refresh_token }` parameter is removed.
- `AccountSession.refreshToken` removed from `@osn/client` — refresh token lives exclusively in the HttpOnly cookie now. Old storage blobs fail schema validation and are purged on load.
- `osn.auth.session.security_invalidation{trigger}` counter replaced by `osn.auth.session.revoked{reason}` with a wider reason union. Dashboards should be updated.
- `osn.auth.session.cookie_fallback` counter removed — no fallback left to count.
- `SecurityInvalidationTrigger` attribute type removed from `@shared/observability`; replaced by `SessionRevokeReason` + `SessionManagementAction`.

See `wiki/systems/sessions.md` for the full design doc.
