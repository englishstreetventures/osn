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
last-reviewed: 2026-04-26
---

# Completed Features

Archived completed feature work from [[TODO]]. For open work see [[TODO]].

## Pulse `@pulse/db/testing` schema helper (2026-04-26)

- **`@pulse/db/testing` export.** New `createSchemaSql()` derives `CREATE TABLE` + `CREATE INDEX` statements directly from the live Drizzle schema (`drizzle-orm/sqlite-core` `getTableConfig`), in foreign-key-respecting topological order. Companion `applySchema(sqlite)` runs the statements against an in-memory SQLite handle.
- **Replaces hand-rolled DDL in 4 places.** `pulse/db/tests/schema.test.ts`, `pulse/db/tests/seed.test.ts`, `pulse/api/tests/helpers/db.ts`, and `pulse/api/tests/services/zapBridge.test.ts` (pulse side) now call `applySchema(sqlite)` instead of duplicating column-by-column `CREATE TABLE` blocks. Adding a column is now a one-file change in `pulse/db/src/schema/`.
- **Drift-guard regression test.** `pulse/db/tests/testing.test.ts` asserts every schema table appears in the emitted SQL, that FK dependents come after their referents, and that every declared index materialises in a fresh DB.
- Test infrastructure only — no runtime behaviour change.

## Pulse event pricing (2026-04-24)

- **Price + currency on events.** New `price_amount` (integer, minor units, nullable) + `price_currency` (ISO 4217 text, nullable) columns on the Pulse `events` table. Effect Schema invariant enforces "both set or both null"; service converts major→minor units before insert. Curated currency allowlist `[USD, EUR, GBP, CAD, AUD, JPY]` lives in `pulse/api/src/lib/currency.ts`. Cap: `99999.99` major units.
- **UI.** `CreateEventForm` gets a price input + currency select with live "Free"/formatted preview. `EventCard` and `EventDetailPage` render a badge: "Free" when null or 0, otherwise `Intl.NumberFormat`-formatted. Helper memoises formatters so long feeds don't reconstruct on every render (P-I1 from perf review). See `[[pulse]]`.

## Auth improvements — Phase 5b (passkey-primary, M-PK, 2026-04-22)

- **Passkey-primary login.** WebAuthn (passkey or security key) is the only primary login factor. `POST /login/otp/{begin,complete}` and `POST /login/magic/{begin,verify}` removed. `AuthMethod` union narrowed to `"passkey" | "recovery_code" | "refresh"`; `AuthRateLimitedEndpoint` dropped `otp_begin`/`otp_complete`/`magic_begin`; `osn.auth.magic_link.sent` counter deleted. — see `[[passkey-primary]]`.
- **Mandatory first-credential enrollment.** `Register.tsx` is gated at the start on `browserSupportsWebAuthn()` (no fallback form), and the flow cannot be dismissed until `/passkey/register/complete` succeeds. The old "Skip for now" button was removed.
- **`enrollmentToken` JWT machinery deleted.** `/register/complete` no longer mints a single-use enrollment token; `/passkey/register/{begin,complete}` now authenticates via the normal access token issued by `/register/complete`. Dropped: `AuthService.issueEnrollmentToken` / `verifyEnrollmentToken`, `consumedEnrollmentTokens` Map, `CompleteRegistrationResult.enrollmentToken` in `@osn/client`, the `enrollmentToken` plumbing in `passkeyRegisterBegin`/`Complete` (now takes `accessToken`).
- **Security keys accepted (S-H2 consistent).** `generateRegistrationOptions` sets `residentKey: "preferred"` + `userVerification: "required"`. FIDO2 keys with PIN/biometric register as non-discoverable; obsolete UP-only U2F tokens cannot register (they would fail at verification anyway — options and verifier must agree). Both identified and identifier-less login use `userVerification: "required"` to match the verifier's `requireUserVerification: true`.
- **S-H1 — Passkey-register step-up gate.** `/passkey/register/begin` requires a fresh step-up token (webauthn or otp AMR) when the account already has ≥1 passkey. First-passkey bootstrap is exempt. `/passkey/register/complete` inserts a `security_events{kind: "passkey_register"}` row atomically, fires a best-effort email notification via `forkDaemon` (10s timeout), and derives the caller's session token from the HttpOnly cookie — H1 invalidation of other sessions cannot be silently skipped by a malicious body. Closes the "stolen access token → silent authenticator binding" vector.
- **S-M1 — Login-begin enumeration safety.** `/login/passkey/begin` returns a uniform `200 { options }` for unknown identifiers, known-with-zero-passkeys, and known-with-passkeys; synthetic branches get a random 32-byte fake credentialId with no persisted challenge. An anonymous caller cannot probe the handle/email namespace.
- **S-M2 — Access-token audience pin.** Access tokens now carry `aud: "osn-access"`; `verifyAccessToken` asserts it. Prevents accidental acceptance of any future token type minted with the same ES256 key.
- **Strict last-passkey guard.** `deletePasskey` refuses unconditionally when the delete would leave 0 passkeys — recovery codes are no longer a substitute credential. Combined with mandatory enrollment on registration this gives the account-level invariant "every live account has ≥1 WebAuthn credential" cradle-to-grave.
- **WebAuthn-unsupported fallback.** `SignIn.tsx` detects missing WebAuthn and shows an informational screen with a "use a recovery code" path; `<MagicLinkHandler>` deleted (no longer has any reason to exist).

## Auth improvements — Phase 5b (PKCE cleanup)

- **Removed legacy OAuth authorization-code / PKCE flow**: deleted `GET /authorize`, the `authorization_code` branch of `POST /token`, the hosted HTML login page (`buildAuthorizeHtml`), and the duplicate hosted-form routes `/passkey/login/*`, `/otp/*`, `/magic/*`. The first-party `/login/*` endpoints (Session + PublicProfile returned inline) are now the only sign-in surface.
- **Service cleanup**: deleted `exchangeCode`, `issueCode`, `completePasskeyLogin`, `completeOtp`, `verifyMagic`, `validateRedirectUri`; removed `AuthConfig.allowedRedirectUris`.
- **Client SDK cleanup (breaking, @osn/client major)**: deleted `OsnAuthService.startLogin`/`handleCallback`, `pkce.ts` (code verifier / challenge helpers), `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`, `OsnAuthConfig.clientId`. Solid `AuthProvider` context drops `login` and `handleCallback`. First-party `CallbackHandler` components removed from `@pulse/app` and `@osn/social` along with their `/callback` routes.
- **Cookie-only `/token` (S-M1)**: `grant_type=refresh_token` reads the session token exclusively from the HttpOnly cookie. The body fallback was a silent-rotation trap (rotated token never returned in body) and a log-leak surface — removed, along with the `osn.auth.session.cookie_fallback` metric.
- **Magic-link routed through frontend (S-H1)**: `beginMagic` now emits a URL on `config.magicLinkBaseUrl ?? config.origin` (the frontend RP origin), not the API. `POST /login/magic/verify` accepts the token in the body; the client app's `MagicLinkHandler` consumes the token on mount and POSTs it. Restores the security posture of the removed redirect path — access token never visible in the browser window, never in URL access logs, resilient to email-client pre-fetchers.
- **OIDC discovery**: `grant_types_supported: ["refresh_token"]` only; `authorization_endpoint`, `response_types_supported`, and `code_challenge_methods_supported` removed.
- **Observability**: `magic_verify` dropped from `AuthRateLimitedEndpoint` and its rate-limiter slot; `osn.auth.session.cookie_fallback` counter deleted.

## Auth improvements — Phase 5a (step-up, sessions, email change)

- **Step-up (sudo) tokens (M-PK1)**: short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"`. Passkey or OTP ceremony mints the token; single-use `jti` replay guard. Required on `/recovery/generate` (breaking — stop-gap 1/day rate limit removed) and `/account/email/complete`. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`. — see [[step-up]]
- **Session introspection + revocation**: `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session carries a coarse UA label (`"Firefox on macOS"`), HMAC-peppered IP hash, and `last_used_at`. Public revocation handle is the first 16 hex of the session-token SHA-256. Metadata preserved across C2 rotations. — see [[sessions]]
- **Email change**: step-up gated `POST /account/email/{begin,complete}`. Begin sends OTP to the NEW email. Complete verifies OTP + step-up token and atomically swaps `accounts.email`, revokes every other session, and inserts an `email_changes` audit row. Hard cap of 2 changes per trailing 7 days.
- **Client SDK cleanup (breaking)**: `Session` and `AccountSession` no longer carry `refreshToken` — cookie-only C3. `AccountSession.hasSession: boolean` replaces the stored token. `/logout` body `refresh_token` parameter removed.
- **Observability**: new `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}` metrics; `SecurityInvalidationTrigger` extended with `session_revoke`, `session_revoke_all`; redaction deny-list extended with `stepUpToken`, `ipHash`, `uaLabel` (both camel + snake spellings).

## Auth improvements — M-PK1b (out-of-band security-event audit for recovery codes)

- **Security events audit trail**: new `security_events` table + partial index on `WHERE acknowledged_at IS NULL` (P-W1). Inserted in the same transaction as BOTH recovery-code regeneration AND successful consumption (S-H1 — the takeover half). Captures the coarse UA label + HMAC-peppered IP hash so the UI can render "was this you?" without exposing raw signals.
- **Fire-and-forget email notifications**: both kinds (`recovery_code_generate`, `recovery_code_consume`) fire a best-effort email post-commit on `Effect.forkDaemon` with a 10 s `Effect.timeout` (P-W2 + S-L1) — the user-visible request latency is decoupled from mailer health. S-L5 framed; codes are never included. Failure is reported via `osn.auth.security_event.notified{result=failed}` and never rolls back the primary action.
- **Step-up-gated dismissal (S-M1)**: `POST /account/security-events/:id/ack` and `POST /account/security-events/ack-all` both require a fresh step-up token (same amr set as `/recovery/generate`). A compromised access token cannot silently dismiss the banner that warns about its own compromise. Ack-all acks every unacked row in one transaction so the user completes one step-up ceremony per banner visit.
- **Client surface**: `GET /account/security-events` (Bearer-auth, rate-limited, explicit projection) + step-up-gated ack routes. `createSecurityEventsClient` in `@osn/client` exposes `list / acknowledge / acknowledgeAll`. `SecurityEventsBanner` in `@osn/ui/auth` opens `StepUpDialog` on "Acknowledge" and uses optimistic local removal (P-I3) — no refetch after dismissal.
- **Observability**: new `osn.auth.security_event.{recorded,notified,acknowledged}` counters + `osn.auth.security_event.notify.duration` histogram. `SecurityEventKind` (`recovery_code_generate | recovery_code_consume`) + `SecurityEventNotifyResult` added to `@shared/observability/metrics` with bounded string-literal unions. Redaction deny-list now includes `securityEventId` / `security_event_id`.
- Unblocks the Phase-5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn OR use the account's recovery codes, and the banner itself is out of the XSS blast radius. — see [[recovery-codes]]

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
- Max event duration prompt (2026-04-24) — duration presets (1h/2h/4h/8h/All day) in `CreateEventForm` when endTime is empty. New `maybe_finished` status (display-only projection; never persisted) at 8h past startTime; auto-close to `finished` at 12h. 48h defence-in-depth cap enforced server-side on explicit-endTime create/update. `EventStatus` union widened in `[[wiki/architecture/component-library]]`-adjacent surfaces; `events.status` column enum widened in `[[wiki/systems/event-access]]`-adjacent schema. See `MAX_EVENT_DURATION_HOURS` / `MAYBE_FINISHED_AFTER_HOURS` / `AUTO_CLOSE_NO_END_TIME_HOURS` in `pulse/api/src/lib/limits.ts`.

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
