# @osn/osn

## 1.8.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

### Patch Changes

- Updated dependencies [811eda4]
  - @osn/db@0.13.0
  - @shared/observability@0.5.2
  - @shared/crypto@0.6.3

## 1.7.1

### Patch Changes

- 58e3e12: Cluster-safe rotated-session store for C2 reuse detection (S-H1 session / P-W1 session). Extracted `RotatedSessionStore` interface with in-memory + Redis-backed impls in `osn/api/src/lib/rotated-session-store.ts`, wired from `osn/api/src/index.ts`. Shipping with `{action, result, backend}`-dimensioned counter + duration histogram (`osn.auth.session.rotated_store.*`) and `RotatedStoreAction`/`RotatedStoreResult`/`RotatedStoreBackend` attribute unions in `@shared/observability`. Fail-open on Redis error so an outage cannot manufacture false-positive family revocations.
- Updated dependencies [58e3e12]
  - @shared/observability@0.5.1
  - @shared/crypto@0.6.2

## 1.7.0

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

### Patch Changes

- Updated dependencies [dc8c384]
  - @osn/db@0.12.0
  - @shared/observability@0.5.0
  - @shared/crypto@0.6.1

## 1.6.0

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

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/db@0.11.0
  - @shared/crypto@0.6.0
  - @shared/observability@0.4.0

## 1.5.0

### Minor Changes

- 2d5cce9: HttpOnly cookie sessions (C3), Origin guard (M1), hash magic/OTP tokens (H2/H3), extract shared auth derive (S-M2)

### Patch Changes

- Updated dependencies [2d5cce9]
  - @shared/observability@0.3.3
  - @shared/crypto@0.5.3

## 1.4.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/db@0.10.0
  - @shared/observability@0.3.2
  - @shared/crypto@0.5.2

## 1.3.0

### Minor Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/db@0.9.0
  - @shared/crypto@0.5.1

## 1.2.0

### Minor Changes

- 0edef32: Switch OSN access token signing from HS256 to ES256 and expose a JWKS endpoint.

  - `@shared/crypto`: add `thumbprintKid(publicKey)` helper (RFC 7638 SHA-256 thumbprint)
  - `@shared/observability`: add `JwksCacheResult` metric attribute type
  - `@osn/api`: replace `AuthConfig.jwtSecret` with `jwtPrivateKey`, `jwtPublicKey`, `jwtKid`, `jwtPublicKeyJwk`; add `GET /.well-known/jwks.json`; update OIDC discovery with `jwks_uri`; ephemeral key pair in local dev when env vars are unset
  - `@pulse/api`: replace symmetric JWT verification with JWKS-backed ES256 verification; add in-process JWKS key cache with 5-minute TTL and rotation-aware refresh; remove `OSN_JWT_SECRET` dependency

### Patch Changes

- Updated dependencies [0edef32]
  - @shared/crypto@0.5.0
  - @shared/observability@0.3.1

## 1.1.1

### Patch Changes

- Updated dependencies [1f14c6a]
  - @shared/crypto@0.4.1

## 1.1.0

### Minor Changes

- 177eeea: Merge `@osn/core` into `@osn/api` and move `@osn/crypto` to `@shared/crypto`.

  - `@osn/api` now owns all auth, graph, org, profile, and recommendations routes and services directly — no longer delegates to `@osn/core`
  - `@shared/crypto` is the new home for ARC token crypto (was `@osn/crypto`); available to all workspace packages
  - ARC audience claim updated from `"osn-core"` to `"osn-api"` for consistency with the merged service identity
  - `@pulse/api` updated to import from `@shared/crypto` and target `aud: "osn-api"` on outbound ARC tokens

### Patch Changes

- Updated dependencies [177eeea]
  - @shared/crypto@0.4.0

## 1.0.3

### Patch Changes

- Updated dependencies [fe55da8]
  - @osn/db@0.8.0
  - @osn/core@0.18.0

## 1.0.2

### Patch Changes

- Updated dependencies [f594a46]
  - @osn/core@0.17.2

## 1.0.1

### Patch Changes

- Updated dependencies [1d9be5a]
  - @osn/core@0.17.1

## 1.0.0

### Major Changes

- 4197434: Rename package from `@osn/app` to `@osn/api` and move directory from `osn/app/` to `osn/api/`. The server binary is now `@osn/api` — a clearer name that signals this is an API server, not a frontend app.

## 0.3.12

### Patch Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).
- Updated dependencies [e2e010e]
  - @osn/core@0.17.0

## 0.3.11

### Patch Changes

- Updated dependencies [d691034]
  - @osn/core@0.16.4

## 0.3.10

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @shared/observability@0.3.0
  - @osn/core@0.16.3

## 0.3.9

### Patch Changes

- Updated dependencies [42589e2]
  - @shared/observability@0.2.10
  - @osn/core@0.16.2

## 0.3.8

### Patch Changes

- Updated dependencies [a723923]
  - @osn/core@0.16.1
  - @osn/db@0.7.2
  - @shared/observability@0.2.9

## 0.3.7

### Patch Changes

- Updated dependencies [8137051]
  - @osn/core@0.16.0
  - @shared/observability@0.2.8

## 0.3.6

### Patch Changes

- Updated dependencies [33e6513]
  - @osn/core@0.15.0
  - @shared/observability@0.2.7

## 0.3.5

### Patch Changes

- Updated dependencies [5520d90]
  - @osn/db@0.7.1
  - @osn/core@0.14.1

## 0.3.4

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/db@0.7.0
  - @osn/core@0.14.0
  - @shared/observability@0.2.6

## 0.3.3

### Patch Changes

- e2ef57b: Add organisation support with membership and role management
- Updated dependencies [e2ef57b]
  - @osn/db@0.6.0
  - @osn/core@0.13.0
  - @shared/observability@0.2.5

## 0.3.2

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/core@0.12.1
  - @osn/db@0.5.3
  - @shared/observability@0.2.4
  - @shared/redis@0.2.2

## 0.3.1

### Patch Changes

- b48d68e: Add ARC token verification middleware and internal graph routes for S2S authentication on `/graph/internal/*` endpoints.
- Updated dependencies [b48d68e]
  - @osn/core@0.12.0

## 0.3.0

### Minor Changes

- 19c39ba: feat(redis): wire up Redis-backed rate limiters (Phase 3)

  - Add `createRedisAuthRateLimiters()` and `createRedisGraphRateLimiter()` factories
    in `@osn/core` that build Redis-backed rate limiters from a `RedisClient`
  - Add `createClientFromUrl()` to `@shared/redis` so consumers don't need ioredis
    as a direct dependency
  - Wire env-driven backend selection in `@osn/app`: `REDIS_URL` set → Redis with
    startup health check; unset → in-memory fallback; graceful degradation on
    connection failure
  - All 12 rate limiters (11 auth + 1 graph) now use Redis when available
  - Resolves S-M2 (rate limiter resets on restart) for production deployments

### Patch Changes

- Updated dependencies [19c39ba]
  - @osn/core@0.11.0
  - @shared/redis@0.2.1

## 0.2.4

### Patch Changes

- Updated dependencies [77ce7ad]
  - @osn/core@0.10.0

## 0.2.3

### Patch Changes

- Updated dependencies [e8b4f93]
  - @osn/core@0.9.0
  - @osn/db@0.5.2
  - @shared/observability@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [f87d7d2]
  - @osn/core@0.8.0
  - @shared/observability@0.2.2

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

- Updated dependencies [1cc3aa5]
  - @osn/core@0.7.0
  - @shared/observability@0.2.1

## 0.2.0

### Minor Changes

- cab97ca: Wire `@shared/observability` into OSN Core (auth + social graph) and the
  OSN auth server (`@osn/app`).

  **`@osn/core`**:

  - New `src/metrics.ts` defines typed OSN Core counters and histograms:
    - `osn.auth.register.attempts{step,result}` + `.duration{step}`
    - `osn.auth.login.attempts{method,result}` + `.duration{method}`
    - `osn.auth.token.refresh{result}`
    - `osn.auth.handle.check{result}` (`available` / `taken` / `invalid`)
    - `osn.auth.otp.sent{purpose}` (`registration` / `login`)
    - `osn.auth.magic_link.sent{result}`
    - `osn.graph.connection.operations{action,result}`
    - `osn.graph.block.operations{action,result}`
  - Curried pipe-friendly helpers (`withAuthRegister("begin")`,
    `withAuthLogin("passkey")`, `withGraphConnectionOp("request")`, …)
    attach a span AND record the outcome in a single `.pipe()` call.
    Duration histograms use the standard latency buckets from
    `@shared/observability`.
  - `classifyError()` maps any caught Effect error into the bounded
    `Result` union so metric cardinality stays compile-time enforced.
  - Auth service: `beginRegistration`, `completeRegistration`, `checkHandle`,
    `refreshTokens`, `beginPasskeyLogin`, `completePasskeyLogin`,
    `completePasskeyLoginDirect`, `beginOtp`, `completeOtp`,
    `completeOtpDirect`, `beginMagic`, `verifyMagic`, `verifyMagicDirect`
    are now instrumented with spans + metrics. OTP-sent and magic-link-sent
    counters fire on the happy path inside the relevant flows.
  - Graph service: `sendConnectionRequest`, `acceptConnection`,
    `rejectConnection`, `removeConnection`, `blockUser`, `unblockUser` are
    instrumented with spans + typed graph counters.

  **`@osn/app`**:

  - Entry point now calls `initObservability({ serviceName: "osn-app" })`
    and wires up `observabilityPlugin` + `healthRoutes` (replacing the
    inline `/health` handler). Updated the existing test to match the new
    shared health-route shape (`{ status: "ok", service: "osn-app" }`).
  - Structured boot log via `Effect.logInfo` instead of `console.log`.

  **Under the hood**:

  - `@shared/observability/src/tracing/layer.ts` now imports `NodeSdk`
    directly from the `@effect/opentelemetry/NodeSdk` subpath (not the
    root barrel) so that vitest doesn't eagerly try to resolve the
    optional `@opentelemetry/sdk-trace-web` peer dep the barrel's
    `WebSdk.js` module pulls in.

  **Out of scope for this PR** (deliberately): migration of stray
  `console.*` calls in auth flows (tracked as S-L8), WebSocket
  instrumentation, dashboards and alerts, actual Grafana Cloud endpoint
  provisioning.

### Patch Changes

- Updated dependencies [cab97ca]
- Updated dependencies [cab97ca]
  - @osn/core@0.6.0
  - @shared/observability@0.2.0

## 0.1.7

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/core@0.5.0
  - @osn/db@0.5.1

## 0.1.6

### Patch Changes

- Updated dependencies [cf57969]
  - @osn/core@0.4.0

## 0.1.5

### Patch Changes

- 3a0196b: Update CLAUDE.md with complete ARC token usage guidance: when to use ARC vs. direct package import, calling/receiving service patterns with code examples, and service registration steps.
- Updated dependencies [3a0196b]
  - @osn/core@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [45248b2]
- Updated dependencies [45248b2]
  - @osn/db@0.5.0
  - @osn/core@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [623ad9f]
  - @osn/db@0.4.0
  - @osn/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [9caa8c7]
  - @osn/db@0.3.0
  - @osn/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [05a9022]
  - @osn/db@0.2.3
  - @osn/core@0.1.1

## 0.1.0

### Minor Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

### Patch Changes

- Updated dependencies [75f801b]
  - @osn/core@0.1.0
  - @osn/db@0.2.2
