---
"@osn/core": minor
"@osn/osn": minor
"@osn/db": patch
"@osn/client": patch
"@osn/pulse": patch
"@osn/api": patch
---

Implement OSN Core auth system.

- `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
- `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
- `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
- `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
- `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
- `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime
