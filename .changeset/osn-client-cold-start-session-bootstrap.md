---
"@osn/client": patch
---

Fix organiser login loop: bootstrap a session from the HttpOnly refresh cookie on cold start.

After a successful passkey sign-in the organiser dashboard performed a full-page navigation, recreating a fresh `AuthProvider`. On that cold start the client had no stored account, so the session resource resolved `null` and `RequireAuth` bounced back to `/login` — even though the refresh cookie set by `/login/passkey/complete` was alive.

`OsnAuthService` now exposes `loadSession()`: when no account is stored it replays the cookie against `POST /token` (`grant_type=refresh_token`, `credentials: "include"`) exactly once (single-flighted), reconstructs and persists the account from the token response, and returns the session. If no/expired cookie is present it resolves to `null` (logged out, fail-safe — never throws). The SolidJS session resource now calls `loadSession()` on mount. The authenticated 401-refresh path and its single-flight guard are unchanged.
