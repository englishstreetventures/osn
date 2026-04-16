# @osn/core

The OSN identity library. Contains every piece of OSN's auth + social graph
logic as reusable Effect services and Elysia route factories:

- **Auth services** — passkey (WebAuthn), OTP, magic link, PKCE, JWT,
  registration, handle claiming
- **Social graph service** — connections, close friends, blocks
- **Route factories** — `createAuthRoutes(config, dbLayer?)`,
  `createGraphRoutes(config, dbLayer?)`
- **Hosted sign-in HTML** — `buildAuthorizeHtml` for the `/authorize` page
  used by third-party OAuth clients (first-party apps use the shared
  SolidJS `<SignIn />` from `@osn/ui/auth` instead)

This package never calls `app.listen()` — it's consumed by `@osn/api`
(or any other OSN platform server). Depends on `@osn/db` for persistence.

## First-party vs third-party sign-in

`/login/*` endpoints return a `Session` directly (no PKCE round-trip) —
designed for trusted first-party apps consuming `@osn/client`. The legacy
`/authorize` → `/token` PKCE path remains for third-party OAuth.
