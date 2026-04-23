---
title: OSN Core
description: OSN identity and authentication stack overview
tags: [app, auth, identity]
status: active
packages:
  - "@osn/api"
  - "@osn/client"
  - "@osn/db"
  - "@osn/ui"
  - "@shared/crypto"
related:
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[social-graph]]"
  - "[[arc-tokens]]"
  - "[[rate-limiting]]"
  - "[[auth-failure]]"
port: 4000
last-reviewed: 2026-04-23
---

# OSN Core

OSN Core is the identity stack every other OSN app builds on. It owns auth (passkey-primary), the social graph, organisations, recommendations, and the handle namespace. The runtime is a single Bun/Elysia binary — `@osn/api` on port 4000 — that ships ARC-protected internal routes for service-to-service callers and Bearer-protected public routes for end users.

## Packages

| Package | Role |
|---|---|
| `@osn/api` | Binary server (port 4000). Hosts auth, graph, organisations, recommendations, S2S routes, and JWKS. |
| `@osn/client` | Browser/SDK: `OsnAuthService`, `useAuth`, plus typed graph / organisation / recommendation clients. |
| `@osn/db` | Drizzle + SQLite schema (accounts, profiles, passkeys, sessions, social graph, organisations, service accounts). |
| `@osn/ui` | Shared SolidJS components for auth flows: `<SignIn>`, `<Register>`, `<RecoveryCodesView>`, `<RecoveryLoginForm>`, `<SessionsView>`, `<SecurityEventsBanner>`, `<StepUpDialog>`, `<ChangeEmailForm>`. |
| `@shared/crypto` | ARC token primitives + recovery-code helpers. |

## Authentication model

Passkey-only primary login. OTP and magic-link primary surfaces were removed; OTP survives only as a step-up / email-change verification factor. See [[passkey-primary]] for the full contract.

| Factor | Where it's used |
|---|---|
| WebAuthn passkey or security key | Primary login (`POST /login/passkey/*`), required at register |
| Recovery code | Lost-device escape hatch (`POST /login/recovery/complete`) |
| Step-up passkey ceremony | Sudo gate for sensitive endpoints — see [[step-up]] |
| Step-up OTP (to verified email) | Step-up fallback factor — see [[step-up]] |

### Public route surface

| Route | Purpose |
|---|---|
| `POST /register/{begin,complete}` | New account + first profile (issues access + session cookie) |
| `POST /passkey/register/{begin,complete}` | Bind a passkey (mandatory at signup; step-up gated thereafter) |
| `POST /login/passkey/{begin,complete}` | Identifier-bound or discoverable WebAuthn login |
| `POST /login/recovery/complete` | Recovery-code login |
| `POST /token` | Refresh-grant rotation (refresh token read **only** from HttpOnly cookie) |
| `POST /logout` | Server-side session destruction |
| `POST /step-up/{passkey,otp}/{begin,complete}` | Mint a single-use sudo token |
| `GET/DELETE /sessions[/:id]`, `POST /sessions/revoke-all-other` | Per-device session management |
| `POST /recovery/generate` | Mint 10 single-use recovery codes (requires step-up) |
| `POST /account/email/{begin,complete}` | Step-up gated email change |
| `GET /account/security-events`, `POST .../ack[-all]` | Audit banner + acknowledgement (step-up gated) |
| `GET/PATCH/DELETE /passkeys[/:id]` | Settings-surface passkey management |
| `POST /profiles/{list,switch}` | Multi-profile session operations |
| `GET /handle/:handle` | Real-time handle availability |
| `GET /.well-known/{jwks.json,openid-configuration}` | JWKS for downstream JWT verification |

### Internal route surface

`/graph/internal/*` and `/organisation-internal/*` are ARC-token gated and reserved for service-to-service callers (e.g. `@pulse/api`). See [[arc-tokens]] and [[s2s-patterns]].

## Social graph

Three relationship types backed by `@osn/db`:

| Relationship | Direction | Notes |
|---|---|---|
| **Connection** | Mutual | Request / accept model |
| **Close friend** | One-directional | One-way flag on an existing connection; not notified |
| **Block** | One-directional | Hard wall on all interaction |

Cross-domain consumers reach the graph through the bridge pattern in `pulse/api/src/services/graphBridge.ts` — see [[s2s-patterns]].

## Handle system

Handles live in a single namespace shared with organisations. They are immutable, validated at the schema layer, and surfaced via `GET /handle/:handle` for real-time availability.

## Testing

```bash
bun run --cwd osn/api test:run     # auth + graph + organisation routes and services
bun run --cwd osn/client test:run  # client SDK
bun run --cwd osn/ui test:run      # shared auth components
```

Auth routes use `createAuthRoutes(authConfig, dbLayer?)` — `authConfig` is required, `dbLayer` defaults to `DbLive`.

## Related

- [[identity-model]] — accounts, profiles, organisations, token model
- [[passkey-primary]] — primary login contract
- [[recovery-codes]] — Copenhagen Book M2 recovery flow
- [[sessions]] — per-device session management
- [[step-up]] — sudo token gating
- [[social-graph]] — connection / close-friend / block semantics
- [[arc-tokens]] — S2S token model used on internal routes
- [[auth-failure]] — debugging runbook
