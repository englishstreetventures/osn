# @shared/observability

## 0.8.1

### Patch Changes

- ac7312b: Add cross-device login: QR-code mediated session transfer allowing authentication on a new device by scanning a QR code from an already-authenticated device.

## 0.8.0

### Minor Changes

- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

### Patch Changes

- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).

## 0.7.0

### Minor Changes

- 6387b98: Passkey-primary login (M-PK). WebAuthn (passkey or security key) is the only primary login factor. OTP and magic-link primary login, and the `enrollmentToken` JWT machinery, have been removed. Registration is WebAuthn-gated and first-credential enrollment is mandatory; `deletePasskey` refuses unconditionally if it would leave zero credentials. The "Lost your passkey?" path (recovery codes) is the single escape hatch.

  Hardenings from the security review: **S-H1** step-up gate on `/passkey/register/*` when the account already has ≥1 passkey + `security_events{passkey_register}` audit row + best-effort email notification + server-derived session token (no user-supplied body field). **S-H2** options/verifier `userVerification` alignment (`required` on both sides; rejects UP-only U2F). **S-M1** `/login/passkey/begin` returns a uniform synthetic response for unknown identifiers, closing the enumeration oracle. **S-M2** access tokens carry `aud: "osn-access"` and `verifyAccessToken` asserts it.

  **Breaking — @osn/api**

  - Removed routes: `POST /login/otp/begin`, `POST /login/otp/complete`, `POST /login/magic/begin`, `POST /login/magic/verify`.
  - Removed service methods: `beginOtp`, `completeOtpDirect`, `beginMagic`, `verifyMagicDirect`, `issueEnrollmentToken`, `verifyEnrollmentToken`.
  - `/passkey/register/{begin,complete}` now authenticates via the normal access token; enrollment tokens are gone.
  - `/passkey/register/begin` accepts an optional `step_up_token` body field or `X-Step-Up-Token` header; **required** when the account already has ≥1 passkey (S-H1).
  - `/passkey/register/complete` body no longer accepts `session_token`; the server derives it from the HttpOnly cookie (S-H1).
  - `/register/complete` response drops `enrollment_token`.
  - `/login/passkey/begin` now returns `200 { options }` in all cases (including unknown identifier) — previously 400 on unknown (S-M1).
  - Access tokens carry `aud: "osn-access"` (S-M2).
  - `AuthConfig` drops `magicLinkBaseUrl` / `magicTtl`; adds `passkeyRegisterAllowedAmr` (default `["webauthn", "otp"]`). `AuthRateLimiters` drops `otpBegin`, `otpComplete`, `magicBegin`.
  - `SecurityEventKind` union adds `"passkey_register"`.
  - `deletePasskey` refuses to drop below 1 passkey regardless of recovery-code state.
  - WebAuthn registration options use `residentKey: "preferred"` + `userVerification: "required"`; both login paths use `userVerification: "required"` to match the verifier (S-H2).

  **Breaking — @osn/client**

  - `LoginClient` now only exposes `passkeyBegin` / `passkeyComplete`. `otpBegin`, `otpComplete`, `magicBegin`, `magicVerify` removed.
  - `CompleteRegistrationResult` no longer contains `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` / `passkeyRegisterComplete` take `accessToken` instead of `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` additionally accepts an optional `stepUpToken` — required when adding a passkey to an account that already has one (S-H1). The bootstrap first-passkey flow from `completeRegistration` still works without it.

  **Breaking — @osn/ui**

  - `<SignIn>` now requires a `recoveryClient: RecoveryClient` prop. The component is WebAuthn-only; it renders an informational screen when WebAuthn is unsupported, and exposes a "Lost your passkey?" link into `<RecoveryLoginForm>`.
  - `<Register>` is WebAuthn-gated. No flow path exists without WebAuthn support, and the "Skip for now" button is gone.
  - `<MagicLinkHandler>` deleted.

  **@shared/observability (minor)**

  - `AuthMethod` narrowed to `"passkey" | "recovery_code" | "refresh"`.
  - `AuthRateLimitedEndpoint` dropped `otp_begin`, `otp_complete`, `magic_begin`.

  **@pulse/app / @osn/social (patch)**

  - Pass a `recoveryClient` into `<SignIn>`; `<MagicLinkHandler>` removed from the root layout.

## 0.6.1

### Patch Changes

- b1d5980: M-PK: passkey-primary prerequisites — passkey management surface + discoverable-credential login.

  **Features**

  - `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (step-up gated) — list, rename, remove credentials from Settings.
  - Discoverable-credential / conditional-UI passkey login. `POST /login/passkey/begin` accepts an empty body and returns `{ options, challengeId }`; clients round-trip the challenge ID to `/login/passkey/complete`.
  - `last_used_at` tracking on every assertion + step-up ceremony (60s coalesce).
  - WebAuthn enrolment tightened to `residentKey: "required"` + `userVerification: "required"`.
  - Hard cap of 10 passkeys per account (P-I10), enforced at both `begin` and `complete`.
  - New `SecurityEventKind` `passkey_delete` — audit row + out-of-band notification, same pattern as recovery-code generate/consume.
  - Last-passkey lockout guard: `DELETE /passkeys/:id` refuses the final credential unless recovery codes exist.
  - New `@osn/client` surface `createPasskeysClient`; `@osn/ui/auth/PasskeysView` settings panel.
  - `SignIn` opportunistically invokes `navigator.credentials.get({ mediation: "conditional" })` on mount when supported.

  **Breaking**

  - Removed the legacy unverified `POST /register` HTTP endpoint — use `/register/begin` + `/register/complete`.
  - `LoginClient.passkeyComplete` now takes `{ identifier | challengeId, assertion }` instead of positional args.
  - `AuthMethod` attribute union dropped `"password"` (OSN is passwordless).

  **DB**

  - Migration `0007_passkey_management.sql` adds `label`, `last_used_at`, `aaguid`, `backup_eligible`, `backup_state`, `updated_at` columns to `passkeys` (all nullable).

  **Observability**

  - New span names `auth.passkey.{list,rename,delete}`.
  - New counter `osn.auth.passkey.operations{action, result}`.
  - New histogram `osn.auth.passkey.duration{action, result}`.
  - New counter `osn.auth.passkey.login_discoverable{result}`.
  - `SecurityInvalidationTrigger` extended with `passkey_delete`.
  - Log redaction deny-list adds `attestation`, `passkeyLabel`/`passkey_label`.

## 0.6.0

### Minor Changes

- c04163d: Remove legacy OAuth authorization-code / PKCE flow.

  The first-party `/login/*` endpoints (Session + PublicProfile returned inline)
  are now the only sign-in surface. The following are gone:

  - Server routes `GET /authorize`, `POST /token` `grant_type=authorization_code`,
    `POST /passkey/login/{begin,complete}`, `POST /otp/{begin,complete}`,
    `POST /magic/begin`, `GET /magic/verify`
  - Service methods `exchangeCode`, `issueCode`, `completePasskeyLogin`,
    `completeOtp`, `verifyMagic`, `validateRedirectUri`; `AuthConfig.allowedRedirectUris`
  - Client API `OsnAuthService.startLogin` / `handleCallback`, module `@osn/client/pkce`,
    errors `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`;
    `OsnAuthConfig.clientId`
  - Solid context methods `login` / `handleCallback`
  - `<CallbackHandler />` components in `@pulse/app` and `@osn/social`
  - Helper files `osn/api/src/lib/html.ts`, `osn/api/src/lib/crypto.ts`
  - Rate-limiter slot `magicVerify` and `AuthRateLimitedEndpoint` variant `magic_verify`

  OIDC discovery now reports `grant_types_supported: ["refresh_token"]` only.
  Magic-link emails point at `/login/magic/verify` (consumed client-side by
  `MagicLinkHandler`).

## 0.5.2

### Patch Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

## 0.5.1

### Patch Changes

- 58e3e12: Cluster-safe rotated-session store for C2 reuse detection (S-H1 session / P-W1 session). Extracted `RotatedSessionStore` interface with in-memory + Redis-backed impls in `osn/api/src/lib/rotated-session-store.ts`, wired from `osn/api/src/index.ts`. Shipping with `{action, result, backend}`-dimensioned counter + duration histogram (`osn.auth.session.rotated_store.*`) and `RotatedStoreAction`/`RotatedStoreResult`/`RotatedStoreBackend` attribute unions in `@shared/observability`. Fail-open on Redis error so an outage cannot manufacture false-positive family revocations.

## 0.5.0

### Minor Changes

- dc8c384: Auth phase 5a: step-up (sudo) ceremonies, session introspection/revocation, and email change.

  **New features**

  - **Step-up (sudo) tokens** — short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"` minted by a passkey or OTP ceremony, required by sensitive endpoints. Replay-guarded via `jti` tracking. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`.
  - **Session introspection + revocation** — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session now carries a coarse UA label (e.g. "Firefox on macOS"), an HMAC-peppered IP hash, and a `last_used_at` timestamp. Revocation handles are the first 16 hex chars of the session SHA-256.
  - **Email change** — `POST /account/email/{begin,complete}`, step-up-gated. Hard cap of 2 changes per trailing 7 days. Atomic with session invalidation so a partial failure can never leave a stale-email session alive. Audit rows persist in the new `email_changes` table.

  **Breaking changes**

  - `/recovery/generate` now requires a step-up token (`X-Step-Up-Token` header or `step_up_token` body param) with `webauthn` or `otp` amr. The old "1 per day" rate limit is replaced by a per-hour throttle; the step-up gate is the real defence.
  - `Session` no longer carries `refreshToken` — the refresh token is HttpOnly-cookie-only after C3. `AccountSession` drops `refreshToken` and adds `hasSession: boolean`. Any stored client session state will fail schema validation and be silently cleared (users will re-login).
  - `POST /logout` no longer accepts `refresh_token` in the body — cookie-only.

  **Observability**

  - New metrics: `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}`.
  - New `SecurityInvalidationTrigger` enum members: `session_revoke`, `session_revoke_all`.
  - New redaction deny-list entries: `stepUpToken`, `ipHash`, `uaLabel` (both spellings).

  Migration `0005_sessions_metadata_and_email_change.sql` adds `sessions.ua_label`, `sessions.ip_hash`, `sessions.last_used_at`, and the new `email_changes` table.

## 0.4.0

### Minor Changes

- 9459f5e: feat(auth): recovery codes (Copenhagen Book M2) + short-lived access tokens

  **Recovery codes (M2)**

  - 10 × 64-bit single-use codes per generation (`xxxx-xxxx-xxxx-xxxx`), SHA-256 hashed at rest in the new `recovery_codes` table.
  - `POST /recovery/generate` (Bearer-auth, 3/hr/IP) returns the raw codes exactly once; regenerating atomically invalidates the prior set.
  - `POST /login/recovery/complete` (5/hr/IP) consumes a code, revokes every session on the account, and establishes a fresh session + cookie.
  - `@shared/crypto` exports `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode`.
  - `@osn/client` exposes `createRecoveryClient`; `@osn/ui` ships `RecoveryCodesView` and `RecoveryLoginForm`.
  - Observability: `osn.auth.recovery.codes_generated`, `osn.auth.recovery.code_consumed{result}`, `osn.auth.recovery.duration`; spans `auth.recovery.{generate,consume}`; redaction deny-list additions for recovery fields.

  **Short-lived access tokens**

  - Default access-token TTL cut from 3600s to 300s (breaking for third-party consumers that cached past `expires_in`).
  - New `OsnAuthService.authFetch(input, init)` (also exposed via the SolidJS `useAuth()` context) silent-refreshes on 401 via the HttpOnly session cookie and retries once; surfaces `AuthExpiredError` when refresh fails.

  **Migration**

  - New Drizzle migration `osn/db/drizzle/0004_add_recovery_codes.sql`.
  - `AuthRateLimiters` gains `recoveryGenerate` and `recoveryComplete` (Redis bundle auto-populated).

  Mitigates prior backlog items: `S-M20` (refresh tokens in localStorage — now paired with a 5-min access-token ceiling) and unblocks M-PK (passkey-primary migration).

## 0.3.3

### Patch Changes

- 2d5cce9: HttpOnly cookie sessions (C3), Origin guard (M1), hash magic/OTP tokens (H2/H3), extract shared auth derive (S-M2)

## 0.3.2

### Patch Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

## 0.3.1

### Patch Changes

- 0edef32: Switch OSN access token signing from HS256 to ES256 and expose a JWKS endpoint.

  - `@shared/crypto`: add `thumbprintKid(publicKey)` helper (RFC 7638 SHA-256 thumbprint)
  - `@shared/observability`: add `JwksCacheResult` metric attribute type
  - `@osn/api`: replace `AuthConfig.jwtSecret` with `jwtPrivateKey`, `jwtPublicKey`, `jwtKid`, `jwtPublicKeyJwk`; add `GET /.well-known/jwks.json`; update OIDC discovery with `jwks_uri`; ephemeral key pair in local dev when env vars are unset
  - `@pulse/api`: replace symmetric JWT verification with JWKS-backed ES256 verification; add in-process JWKS key cache with 5-minute TTL and rotation-aware refresh; remove `OSN_JWT_SECRET` dependency

## 0.3.0

### Minor Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.

## 0.2.10

### Patch Changes

- 42589e2: Default log level to debug in dev environment so OTP codes and magic-link URLs are visible without manual OSN_LOG_LEVEL configuration. Tighten OTP/magic-link debug guard from NODE_ENV to OSN_ENV so staging is also excluded.

## 0.2.9

### Patch Changes

- a723923: feat(core): Multi-account P6 — Privacy audit

  - Add `passkeyUserId` column to `accounts` table (random UUID, generated at account creation) to prevent WebAuthn-based profile correlation — passkey registration now uses this opaque ID instead of `accountId` as the WebAuthn `user.id`
  - Add `accountId` / `account_id` to the observability redaction deny-list as defence in depth against log-based correlation
  - Add privacy invariant test suite verifying `accountId` never leaks in API responses, token claims, or profile data
  - Audit confirmed: all route responses, span attributes, metric attributes, and rate limit keys are clean

## 0.2.8

### Patch Changes

- 8137051: feat: Profile CRUD (multi-account P3) — create, delete, set default

  Adds `createProfileService()` with three operations:

  - `createProfile`: creates a new profile under an existing account, enforces `maxProfiles` limit (fixes S-L1), validates handle against both user and org namespaces
  - `deleteProfile`: cascade-deletes all profile-owned data (connections, close friends, blocks, org memberships) in a single transaction, guards against deleting the last profile or org-owning profiles
  - `setDefaultProfile`: changes which profile is the default for token refresh

  Three new REST routes: `POST /profiles/create`, `POST /profiles/delete`, `POST /profiles/:profileId/default` with per-endpoint rate limiting (5/min create+delete, 10/min set-default).

  Observability: `ProfileCrudAction` bounded union, `osn.profile.crud.operations` counter, `osn.profile.crud.duration` histogram, `withProfileCrud` span+metric wrapper.

  Resolves S-L1 (maxProfiles enforcement) and S-L2 (email dedup confirmed clean).

## 0.2.7

### Patch Changes

- 33e6513: Multi-account P2: two-tier token model and profile switching

  Refresh tokens are now scoped to accounts (sub=accountId), access tokens remain scoped to profiles (sub=profileId). This enables profile switching without re-authentication.

  New endpoints:

  - `POST /profiles/switch` — switch to a different profile under the same account
  - `GET /profiles` — list all profiles for the authenticated account

  New service functions: `switchProfile`, `listAccountProfiles`, `verifyRefreshToken`, `findDefaultProfile`.

  New metric: `osn.auth.profile_switch.attempts` with bounded `ProfileSwitchAction` attribute union.

  Breaking: existing refresh tokens (profile-scoped) will fail on refresh — users must re-authenticate once.

## 0.2.6

### Patch Changes

- f5c1780: feat: add multi-account schema foundation (accounts table, userId → profileId rename)

  Introduces the `accounts` table as the authentication principal (login entity) and renames
  `userId` to `profileId` across all packages to establish the many-profiles-per-account model.

  Key changes:

  - New `accounts` table with `id`, `email`, `maxProfiles`
  - `users` table gains `accountId` (FK → accounts) and `isDefault` fields
  - `passkeys` re-parented from users to accounts (`accountId` FK)
  - All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
  - Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
  - Registration flow creates account + first profile atomically

## 0.2.5

### Patch Changes

- e2ef57b: Add organisation support with membership and role management

## 0.2.4

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.3

### Patch Changes

- e8b4f93: Add close friends to the OSN graph properly

  - Add `isCloseFriendOf` and `getCloseFriendsOfBatch` helpers to the graph service
  - Add `GET /graph/close-friends/:handle` status check endpoint
  - Instrument close friend operations with metrics (`osn.graph.close_friend.operations`) and tracing spans
  - Fix `removeConnection` to clean up close-friend entries in both directions (consistency bug)
  - Transaction-wrap `removeConnection` and `blockUser` multi-step mutations
  - Add `close_friends_friend_idx` index on `friend_id` for reverse lookups
  - Clamp `getCloseFriendsOfBatch` input to 1000 items (SQLite variable limit)
  - Sanitize error objects in graph operation log annotations
  - Migrate Pulse graph bridge from raw SQL to service-level `getCloseFriendsOfBatch`
  - Add `GraphCloseFriendAction` attribute type to shared observability

## 0.2.2

### Patch Changes

- f87d7d2: Auth security hardening: per-IP rate limiting on all auth endpoints (S-H1), redirect URI allowlist validation (S-H3), mandatory PKCE at /token (S-H4), legacy unauth'd passkey path removed (S-H5), login OTP attempt limit + unbiased generation + timing-safe comparison (S-M7/M24/M25), dev-log NODE_ENV gating (S-M22), console.\* replaced with Effect.logError. Oxlint no-new warning fixed in @pulse/api. AuthRateLimitedEndpoint type added to @shared/observability.

## 0.2.1

### Patch Changes

- 1cc3aa5: Migrate dev-mode `console.log` of registration OTP, login OTP, and magic-link
  URL in `osn/core/src/services/auth.ts` to `Effect.logDebug` (S-H21). The values
  stay interpolated into the message string so the redacting logger doesn't scrub
  them — the whole point of these dev branches is to expose the code/URL to the
  developer.

  `createAuthRoutes` and `createGraphRoutes` now accept an optional third
  `loggerLayer: Layer.Layer<never>` parameter (defaulting to `Layer.empty`) which
  is provided to the per-request Effect runtime alongside `dbLayer`. Without this
  wiring `Effect.logDebug` calls inside auth services would be silently dropped
  by Effect's default `Info` minimum log level, breaking local dev UX after the
  migration. `osn/app/src/index.ts` now threads its `observabilityLayer` through
  to both route factories (S-L1). The parameter is optional and backwards
  compatible for any downstream caller.

  Trim the redaction deny-list in `@shared/observability` to only the keys that
  correspond to real object properties in the codebase today: `authorization`,
  the OAuth token fields (`accessToken`/`refreshToken`/`idToken`/`enrollmentToken`

  - snake_case), the WebAuthn `assertion` body, ARC `privateKey`, and the user
    PII fields `email` / `handle` / `displayName`. Removes ~30 speculative entries
    (Signal/E2E keys, password fields, address/SSN/etc.) that were never reached.
    `enrollmentToken` is added because it is a real bearer credential returned by
    `/register/complete` and sent back as `Authorization: Bearer <token>` for
    passkey enrollment (S-M1). Adds a documented criteria block at the top of
    `redact.ts` explaining when to add or remove keys, a lock-step assertion in
    `redact.test.ts` pinning the exact set, a positive assertion for the enrollment
    token, and a behavioural regression anchor (T-S1) that proves previously-
    scrubbed keys now pass through unchanged. Dev-log branch coverage is locked
    with three new `it.effect` tests using a `Logger.replace` capture sink (T-U1).

## 0.2.0

### Minor Changes

- cab97ca: Scaffold `@shared/observability` — OSN's single source of truth for logs,
  metrics, and tracing.

  **New package `@shared/observability`** exports:

  - `initObservability(overrides)` — one-shot bootstrap that loads config
    from env vars (`OSN_SERVICE_NAME`, `OSN_ENV`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
    …) and returns a combined Effect Layer wiring up the logger, OTel tracer,
    and metric exporter.
  - **Logger** — Effect `Logger.jsonLogger` in prod, `Logger.prettyLogger()` in
    dev, both wrapped with a deny-list redaction pass that scrubs ~30 known
    secret-bearing keys (`password`, `email`, `token`, `ciphertext`, `ratchetKey`,
    …) from log annotations and errors before serialization. Add new keys to
    `src/logger/redact.ts`; never remove.
  - **Metrics factory** — typed `createCounter<Attrs>`, `createHistogram<Attrs>`,
    `createUpDownCounter<Attrs>`. The `<Attrs>` generic pins allowed attribute
    keys at declaration so TypeScript rejects unbounded values (userId,
    requestId, …) at compile time. Standard latency buckets
    (`LATENCY_BUCKETS_SECONDS`) and byte buckets (`BYTE_BUCKETS`) exported
    for consistency.
  - **HTTP RED metrics** — `http.server.requests`, `http.server.request.duration`,
    `http.server.active_requests` following OTel semantic conventions. Emitted
    automatically by the Elysia plugin; handlers never call these directly.
  - **Tracing layer** — `@effect/opentelemetry` NodeSdk with OTLP trace +
    metric exporters, parent-based trace-id-ratio sampler (1.0 in dev, 0.1
    in prod by default, overridable via `OSN_TRACE_SAMPLE_RATIO`).
  - **W3C propagation helpers** — `injectTraceContext(headers)` and
    `extractTraceContext(headers)` so outbound fetches participate in the
    same trace.
  - **`instrumentedFetch`** — drop-in replacement for `globalThis.fetch` that
    creates a client span, injects `traceparent`, and records status/errors.
    Use for all S2S HTTP calls.
  - **Elysia plugin** `observabilityPlugin({ serviceName })` — wires up per-
    request spans, request ID propagation (`x-request-id`), OTel HTTP semconv
    attributes, and RED metric emission via `onRequest` / `onAfterHandle` /
    `onError` / `onAfterResponse` hooks.
  - **Health routes** — `/health` (liveness; always 200 if the process is up)
    and `/ready` (readiness; takes an optional `probe` function that runs a
    trivial dep check like `SELECT 1`).

  **Metrics conventions** (see `CLAUDE.md` "Observability" section for the
  full rules):

  - Naming: `{namespace}.{domain}.{subject}.{measurement}` (e.g.
    `pulse.events.created`, `osn.auth.login.attempts`, `arc.token.issued`).
  - Every metric declared exactly once in a co-located `metrics.ts` file
    (`pulse/api/src/metrics.ts`, `osn/crypto/src/arc-metrics.ts`, …) via
    typed helpers — raw OTel meter calls are banned.
  - Default resource attributes (`service.name`, `service.namespace`,
    `service.version`, `service.instance.id`, `deployment.environment`) are
    applied automatically by the SDK init; never set per-metric.
  - Per-metric attribute values must be bounded string-literal unions
    (`"ok" | "error" | "rate_limited"`), never `string`.

  **Wired into `@pulse/api`**:

  - Elysia plugin and health routes active in `src/index.ts`.
  - `src/metrics.ts` defines Pulse domain metrics (`pulse.events.created`,
    `pulse.events.updated`, `pulse.events.deleted`, `pulse.events.listed`,
    `pulse.events.create.duration`, `pulse.events.status_transitions`,
    `pulse.events.validation.failures`) via typed counters.
  - `src/services/events.ts` is instrumented: every service function is
    wrapped in `Effect.withSpan("events.<op>")`, and domain counters fire
    on success/error paths.

  **Wired into `@osn/crypto`**:

  - New `src/arc-metrics.ts` with typed ARC counters (`arc.token.issued`,
    `arc.token.verification`, `arc.token.cache.hits`/`misses`,
    `arc.token.public_key.cache.hits`/`misses`).
  - `createArcToken`, `verifyArcToken`, `getOrCreateArcToken`, and
    `resolvePublicKey` now emit metrics on the happy path and classify
    verification failures into the bounded `ArcVerifyResult` union
    (`ok | expired | bad_signature | unknown_issuer | scope_denied |
audience_mismatch | malformed`).

  **Out of scope for this PR** (deliberately): wiring into `@osn/app` and
  `@osn/core` (tracked as follow-ups), WebSocket instrumentation, dashboards
  and alert rules, migration of stray `console.*` calls in auth routes
  (tracked separately as S-L8).

  30 new tests across redaction, config parsing, trace propagation, health
  routes, and the metrics factory. Full monorepo test suite passes (390+
  tests).
