---
title: Completed Features
tags: [changelog, features]
related:
  - "[[TODO]]"
  - "[[pulse]]"
  - "[[osn-core]]"
  - "[[zap]]"
  - "[[redis]]"
  - "[[identity-model]]"
last-reviewed: 2026-04-19
---

# Completed Features

Archived completed feature work from [[TODO]]. For open work see [[TODO]].

## Auth improvements — Phase 5a (step-up, sessions, email change)

- **Step-up (sudo) tokens (M-PK1)**: short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"`. Passkey or OTP ceremony mints the token; single-use `jti` replay guard. Required on `/recovery/generate` (breaking — stop-gap 1/day rate limit removed) and `/account/email/complete`. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`. — see [[step-up]]
- **Session introspection + revocation**: `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session carries a coarse UA label (`"Firefox on macOS"`), HMAC-peppered IP hash, and `last_used_at`. Public revocation handle is the first 16 hex of the session-token SHA-256. Metadata preserved across C2 rotations. — see [[sessions]]
- **Email change**: step-up gated `POST /account/email/{begin,complete}`. Begin sends OTP to the NEW email. Complete verifies OTP + step-up token and atomically swaps `accounts.email`, revokes every other session, and inserts an `email_changes` audit row. Hard cap of 2 changes per trailing 7 days.
- **Client SDK cleanup (breaking)**: `Session` and `AccountSession` no longer carry `refreshToken` — cookie-only C3. `AccountSession.hasSession: boolean` replaces the stored token. `/logout` body `refresh_token` parameter removed.
- **Observability**: new `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}` metrics; `SecurityInvalidationTrigger` extended with `session_revoke`, `session_revoke_all`; redaction deny-list extended with `stepUpToken`, `ipHash`, `uaLabel` (both camel + snake spellings).

## Multi-account

- **P1 — Schema foundation**: `accounts` table, `userId` → `profileId` rename across all packages, seed data with multi-profile user (21 accounts, 23 profiles, 2 orgs), registration creates account + profile atomically. 81 files, 700+ tests green.
- **P1b — Terminology audit**: "user" now only means "the person". All data structures use account/profile/organisation. Renames: `User` → `Profile`, `PublicUser` → `PublicProfile`, etc. — see [[identity-model]]
- **P2 — Auth refactor**: two-tier token model (refresh = account, access = profile), `POST /profiles/switch`, `POST /profiles/list`, `verifyRefreshToken`, `findDefaultProfile`. Scope claim validation. Per-account rate limiting (20 switches/hr). 373 core tests green. — see [[identity-model]]

## Pulse

- Initialize Tauri app with SolidJS, iOS target configured
- Event data model, schema, CRUD operations (list, today, get, create, update, delete)
- Event CRUD UI (create form, delete, Eden client, shadcn tokens)
- Event lifecycle auto-transitions (on-read, no background job)
- Location autocomplete (`LocationInput` with debounce/abort)
- Auth callback handler (`CallbackHandler`)
- Test coverage: utils, LocationInput, CreateEventForm, EventCard, EventList
- Toast notification system (solid-toast)
- Registration UI: multi-step flow (email + handle + display name → OTP → passkey)
- Coordinate storage (lat/lng from Photon) + Maps button on EventCard
- Full event view at `/events/:id` with shareable URL
- Map preview (Leaflet + OpenStreetMap, no API key)
- iCal export (ICS) — `GET /events/:id/ics` + Add-to-calendar button
- RSVP service: upsert/list/counts/invite, cross-DB join
- RSVP visibility filtering — public / connections / private guest lists
- Event public/private discovery flag
- Join policy — `open` vs `guest_list`
- Allow-interested toggle
- Communications config + stubbed blast log
- Per-step info popovers in `CreateEventForm`
- `pulse_users` table + `PATCH /me/settings`
- Event chat placeholder
- Hidden attendance option (`attendanceVisibility = "no_one"`)
- `isCloseFriendOf`/`getCloseFriendsOfBatch` migrated from SQL to service helper

## OSN Core

- OAuth/OIDC provider (passkey, OTP, magic link, PKCE, JWT) — 50 tests
- User registration/login flows
- `osn/app` auth server entry point (port 4000)
- Social graph data model (connections, close friends, blocks) — 209 tests
- Handle system — registration, real-time availability, email/handle sign-in toggle
- ARC token verification middleware on `/graph/internal/*` — 21 new tests
- Organisation support — schema, Effect service, REST + ARC routes, observability, 355 tests
- Multi-account schema foundation (P1) — 81 files changed
- Multi-account auth refactor (P2) — two-tier tokens, profile switching

## Zap

- `@zap/api` workspace (Elysia + Eden, port 3002)
- `@zap/db` workspace (Drizzle + SQLite)
- Initial test infra (`createTestLayer()`) for `@zap/api` and `@zap/db`
- Turbo pipeline integration (build / check / test)
- `@zap/db` schema: `chats`, `chat_members`, `messages`
- `@zap/api` routes: chat CRUD, member management, message send/list with cursor pagination
- Event chat linking: `chatId` column on events, `zapBridge`
- `organisations` + `organisation_members` tables in `@osn/db`

## Landing

- Astro + Solid scaffolding

## Platform

### Pulse API
- Elysia setup + Eden client
- Effect.ts trial integration
- Events domain — 47 tests

### Database
- Per-app DB packages (osn-db, pulse-db)
- Pulse: events schema, migrations, smoke tests
- OSN Core: users + passkeys schema, migration, smoke tests
- OSN Core: social graph schema
- OSN Core: `service_accounts` table (ARC token verification)
- Pulse: `chatId` column on events + chat/message schema in `@zap/db`

### Auth Client (`osn/client`)
- Eden client wrapper
- `getSession()` with expiry check
- `AuthProvider` + `handleCallback` for SolidJS — 10 tests

### Crypto (`osn/crypto`)
- `generateArcKeyPair()` — ES256 keypair generation
- `createArcToken()` / `verifyArcToken()` — sign/verify scoped JWTs
- `resolvePublicKey()` — DB lookup with Effect
- In-memory token cache with 30s-before-expiry eviction
- Key import/export utilities

### Infrastructure
- Turborepo + Changesets
- Shared TypeScript configs
- CI/CD (GitHub Actions) — lint, format, typecheck, tests, security review
- lefthook pre-commit/pre-push hooks
- oxlint + oxfmt
- Claude Code GitHub integration + skills
- UserPromptSubmit hook
- Changeset Check workflow (catches workspace name typos)

### Redis Migration — Phases 1–3

**Phase 1 — Abstraction layer**: `RateLimiterBackend` interface, refactored graph route inline limiter, DI for testability.

**Phase 2 — `@shared/redis` package**: Effect-based `Redis` service, `RedisLive` layer, `createRedisRateLimiter()` (Lua atomic INCR+PEXPIRE), health probe, in-memory fallback, 13 tests.

**Phase 3 — Wire up**: `createRedisAuthRateLimiters()` + `createRedisGraphRateLimiter()`, env-driven backend selection, 12 rate limiters Redis-backed when available, 10 integration tests.
