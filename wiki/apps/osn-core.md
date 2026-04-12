---
title: OSN Core
description: OSN identity and authentication stack overview
tags: [app, auth, identity]
status: active
packages:
  - "@osn/app"
  - "@osn/core"
  - "@osn/client"
  - "@osn/crypto"
  - "@osn/db"
  - "@osn/ui"
port: 4000
---

# OSN Core

OSN Core is the identity and authentication stack for the OSN platform. It provides auth flows, social graph management, and the handle system that all other apps build on.

## Architecture

**`@osn/core` is a library -- it never calls `listen()`.** It exports Elysia route factories (`createAuthRoutes`, `createGraphRoutes`) and Effect services. The actual running server is `@osn/app`, which imports `@osn/core` and listens on port 4000.

This distinction matters: `@osn/core` can be imported by other packages (e.g. Pulse imports `createGraphService()` directly for zero-overhead graph queries), while `@osn/app` is the deployable binary.

```
@osn/app (binary, port 4000)
  └── @osn/core (library)
        ├── Auth routes + services
        ├── Graph routes + services
        ├── Hosted /authorize HTML (PKCE, third-party OAuth)
        └── @osn/db (Drizzle + SQLite)
```

## Auth Flows

OSN Core supports four authentication methods:

- **Passkey** -- WebAuthn-based passwordless auth. Registration and login via `/register/begin`, `/register/complete`, `/login/passkey/begin`, `/login/passkey/complete`. Preferred method.
- **OTP** -- One-time password sent via email. `/otp/begin` sends the code, `/otp/complete` verifies it. 10-minute TTL.
- **Magic Link** -- Clickable email link. `/magic/begin` sends the link, `/magic/verify` handles the callback.
- **PKCE** -- Authorization Code flow with Proof Key for Code Exchange. Used by the hosted `/authorize` HTML page for third-party OAuth clients. First-party apps (like Pulse) use the direct `/login/*` + `/register/*` endpoints instead.
- **JWT** -- Session tokens issued on successful auth. Includes `handle` claim. Refresh via `/login/refresh`.

### First-party vs Third-party

First-party apps (Pulse, Zap) call `/login/*` and `/register/*` endpoints directly and receive `{ session, user }` responses. No PKCE overhead.

Third-party OAuth clients go through the hosted `/authorize` page and the full PKCE flow.

## Social Graph

The social graph service manages user relationships with three relationship types:

- **Connections** -- Mutual follow. Request/accept model.
- **Close Friends** -- One-directional flag on an existing connection. The other user is not notified.
- **Blocks** -- Prevents all interaction. Blocked user cannot see blocker's content.

The graph service has 209 tests covering all edge cases. Routes are exposed via `createGraphRoutes()`.

### Graph Bridge

Other services access graph data through a bridge pattern. Pulse uses `graphBridge.ts` as the single import surface for `@osn/core` + `@osn/db`, keeping cross-boundary calls traceable and making the eventual migration to HTTP+ARC a single-file change. See [[s2s-patterns]] for details.

## Handle System

Every user has a unique handle. The system provides:

- Real-time availability checking via `/handle/:handle`
- Validation rules enforced at the schema layer
- Handle claim included in JWT for downstream use

## Shared UI Components

Both `<Register />` and `<SignIn />` live in `@osn/ui/auth/*`. They:

- Receive an injected client prop (from `@osn/client`)
- Talk to first-party `/login/*` + `/register/*` endpoints
- Return `{ session, user }` directly (no PKCE)
- Are consumed by Pulse and will be consumed by Zap

Additional shared components:
- `<MagicLinkHandler />` -- handles magic link deep-link callbacks

## Related Packages

| Package | Role |
|---------|------|
| `@osn/app` | Binary server (port 4000) |
| `@osn/core` | Library: route factories + Effect services |
| `@osn/client` | SDK: `createRegistrationClient`, `createLoginClient`, `OsnAuthService`; `@osn/client/solid` for `AuthProvider` + `useAuth` |
| `@osn/crypto` | ARC tokens (S2S auth); Signal protocol (pending) |
| `@osn/db` | Drizzle + SQLite (users, passkeys, social graph, service accounts) |
| `@osn/ui` | Shared SolidJS components for auth flows |

## Testing

```bash
bun run --cwd osn/core test:run    # Run OSN core tests once
bun run --cwd osn/client test:run  # Run client SDK tests once
bun run --cwd osn/ui test:run      # Run shared UI tests once
```

Auth routes use `createAuthRoutes(authConfig, dbLayer?)` -- config is required, `dbLayer` defaults to `DbLive`.

## Related

- [[social-graph]] -- social graph architecture details
- [[arc-tokens]] -- service-to-service authentication
- [[rate-limiting]] -- per-IP rate limiting on auth endpoints
- [[auth-failure]] -- auth flow debugging runbook
- [[monorepo-structure]] -- workspace layout and naming conventions
