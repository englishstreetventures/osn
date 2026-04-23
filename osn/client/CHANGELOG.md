# @osn/client

## 2.1.0

### Minor Changes

- 1d68593: Let users add additional biometrics (passkeys) after registration. Registration already required enrolling a first passkey; Settings now exposes a Security tab with an "Add passkey" button that runs the step-up-gated WebAuthn registration ceremony, plus the existing list / rename / delete surface. `PasskeysClient` gains `registerBegin` / `registerComplete` so the Settings surface can call `/passkey/register/begin` + `/complete` directly.

## 2.0.1

### Patch Changes

- 31957b4: Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
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

## 2.0.0

### Major Changes

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

## 1.1.0

### Minor Changes

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

## 1.0.0

### Major Changes

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

## 0.10.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

## 0.9.0

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

## 0.8.0

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

## 0.7.0

### Minor Changes

- 2d5cce9: HttpOnly cookie sessions (C3), Origin guard (M1), hash magic/OTP tokens (H2/H3), extract shared auth derive (S-M2)

## 0.6.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

## 0.5.1

### Patch Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

## 0.5.0

### Minor Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).

## 0.4.0

### Minor Changes

- fcd8e8f: Multi-account P4: Client SDK profile management — multi-session storage model with per-profile access tokens, profile list/switch/create/delete methods, SolidJS context integration, and legacy session migration.

## 0.3.2

### Patch Changes

- f2fbc2a: Replace valibot with Effect Schema for token response validation, consolidating all non-HTTP-boundary validation on Effect Schema

## 0.3.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.

## 0.3.0

### Minor Changes

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

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.0

### Minor Changes

- 97f35e5: Add shared in-app sign-in and registration across the OSN stack.

  **`@osn/core`** — new first-party `/login/*` endpoints that return a
  `Session + PublicUser` directly, mirroring the existing `/register/*`
  flow with no PKCE round-trip:

  - `POST /login/passkey/{begin,complete}`
  - `POST /login/otp/{begin,complete}` (enumeration-safe: `begin` always
    returns `{ sent: true }`)
  - `POST /login/magic/{begin}` + `GET /login/magic/verify?token=…`

  Service layer refactored to extract `verifyPasskeyAssertion`,
  `verifyOtpCode`, and `consumeMagicToken` helpers so the direct-session
  variants (`completePasskeyLoginDirect`, `completeOtpDirect`,
  `verifyMagicDirect`) share verification logic with the existing
  code-issuing variants. The hosted `/authorize` HTML + PKCE path is
  unchanged and remains the third-party OAuth entry point.

  **`@osn/client`** — new `createLoginClient({ issuerUrl })` factory
  mirroring `createRegistrationClient`, with `passkeyBegin/Complete`,
  `otpBegin/Complete`, `magicBegin/Verify` methods. Throws `LoginError`
  on non-2xx. Returned sessions are already parsed via `parseTokenResponse`
  and ready to pass to `AuthProvider.adoptSession`.

  **`@osn/ui`** — new shared SolidJS components under `@osn/ui/auth`:

  - `<Register />` — migrated from `@pulse/app` with a new `client` prop
    so it's decoupled from any specific app's env config.
  - `<SignIn />` — new three-tab sign-in (passkey / OTP / magic) driving
    the new `/login/*` endpoints through an injected `LoginClient`. Auto-
    falls-back to OTP when WebAuthn is unsupported.
  - `<MagicLinkHandler />` — invisible root-level component that exchanges
    a `?token=…` query param for a session and clears the URL.

  Package now pulls in the SolidJS + Vitest + @simplewebauthn/browser
  devDeps it needs to actually host these components.

  **`@pulse/app`** — replaces the old `useAuth().login()` redirect to
  `/authorize` with an in-app `<SignIn />` modal. Imports `<Register>`,
  `<SignIn>`, and `<MagicLinkHandler>` from `@osn/ui/auth/*`; shared
  `RegistrationClient` and `LoginClient` instances live in
  `src/lib/authClients.ts` and are injected as props.

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

## 0.1.0

### Minor Changes

- cf57969: Add an email-verified registration flow end-to-end with passkey enrolment, plus a security redesign that addresses the critical findings raised during review.

  **`@osn/core` — new endpoints + service work**

  - `POST /register/begin` — validates email + handle, normalises email to lowercase, generates an unbiased 6-digit OTP via rejection sampling, stores a pending registration in a bounded (10k cap), swept-on-insert in-memory map, and emails the OTP. Always returns `{ sent: true }` regardless of conflict to remove the user-enumeration oracle (S-M1/S-M26). Refuses to overwrite a non-expired pending entry to prevent griefing of in-progress registrations (S-M2/S-M23).
  - `POST /register/complete` — verifies the OTP using a constant-time comparison (S-M4/S-M25), enforces a 5-attempts-then-wipe brute-force cap (S-H1 partial), inserts the user using the DB unique constraint as the source of truth (no TOCTOU; the pending entry is only deleted after a successful insert — S-H4/S-H10), and returns access + refresh tokens **directly** alongside a single-use enrollment token. The registration code path no longer touches `/token` so it does not depend on the pre-existing PKCE bypass at `/token` (tracked separately as S-H4/S-H9).
  - New `issueEnrollmentToken` / `verifyEnrollmentToken` service helpers — short-lived (5 min) JWTs of `type: "passkey-enroll"`, single-use via an in-memory consumed-jti set with opportunistic sweep.
  - `POST /passkey/register/{begin,complete}` now accept an `Authorization: Bearer <token>` header where the token is either an enrollment token or a normal access token; the token's `sub` is compared against the body `userId` and a mismatch returns `401` (S-C1/S-H5 partial). The legacy unauth'd path is preserved with a deprecation warning so the hosted `/authorize` HTML page still works; removing it is tracked in the security backlog.
  - New `publicError()` route helper maps Effect-tagged errors to opaque public payloads (`invalid_request`, `internal_error`) and logs the underlying cause server-side (S-H5/S-M6/S-M4).
  - Dev-only `console.log` of OTP codes is now gated on `NODE_ENV !== "production"` (S-M3/S-M22).

  **`@osn/client` — RegistrationClient redesign**

  - `createRegistrationClient` exposes `checkHandle`, `beginRegistration`, `completeRegistration`, `passkeyRegisterBegin`, `passkeyRegisterComplete`. **`exchangeAuthCode` is gone** — `completeRegistration` now returns a parsed `Session` ready for `AuthProvider.adoptSession` plus an `enrollmentToken`. Both passkey calls accept the enrollment token and send it as `Authorization: Bearer <token>`.
  - New `OsnAuth.setSession` + Solid `AuthProvider.adoptSession` for installing a session obtained out-of-band by the registration flow.

  **`@osn/pulse` — Register component**

  - Multi-step UI: details (email + handle + display name with debounced live availability check) → 6-digit OTP → optional passkey enrolment → done.
  - `adoptSession` is called immediately after OTP verification, **before** any passkey work — the user is signed in regardless of whether they go on to set up a passkey, so a flaky WebAuthn ceremony or an unsupported environment can no longer leave them stranded.
  - WebAuthn feature-detection via `browserSupportsWebAuthn()`; the passkey step is skipped entirely (and the UI jumps straight to "done") on environments without WebAuthn — currently Tauri's iOS webview, until we ship the native plugin.
  - Imperative skip path replacing the previous `createEffect` (P-I10), inlined `detailsValid` accessor (P-I11), module-scope `RegistrationClient` (P-I12).
  - Wired into `EventList` as a "Create account" button next to "Sign in with OSN".

  **Test coverage** (277 tests total, +58 from the previous PR baseline)

  - Service-level: happy path, lowercase normalisation, no-row-before-verify, ValidationError on bad inputs, enumeration-resistant begin, refuse-to-overwrite pending entry, wrong OTP, no-pending error, single-use replay, brute-force attempt cap, TOCTOU loss against legacy `/register`, enrollment token issue/verify/consume, replay rejection, type-claim discrimination.
  - Route-level: complete shape assertions, enumeration-resistant 200 responses, complete-without-begin, replay attack, reserved handle availability, Authorization gating with valid enrollment token / valid access token / mismatched sub / invalid bearer / legacy unauth'd path, enrollment-token consumption on `/complete`.
  - Client unit tests: URL composition, body shapes, Authorization header propagation, RegistrationError on non-OK, trailing-slash issuerUrl normalisation.
  - Solid `AuthProvider.adoptSession` round-trip test (real provider, harness component, asserts both `useAuth().session()` reactivity and `localStorage` persistence).
  - Pulse Register component test: input sanitisation, debounced availability with stale-result guard, `detailsValid` gating during `checking`, OTP digit-only clamp, immediate `adoptSession` after OTP, happy passkey enrolment with enrollment token propagation, "Skip for now" → done, WebAuthn-unsupported jump-to-done, Cancel.

## 0.0.3

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

## 0.0.2

### Patch Changes

- 880e762: Add @osn/client package with OAuth 2.0 + PKCE auth core, SolidJS and React adapters. Wire AuthProvider into Pulse.
