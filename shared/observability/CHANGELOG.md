# @shared/observability

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
