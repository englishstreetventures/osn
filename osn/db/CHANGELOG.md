# @osn/db

## 0.17.3

### Patch Changes

- 630e98f: TODO-backlog hardening sweep:

  - **S-H (arc-scope-pattern)** — `@shared/crypto` `SCOPE_PATTERN` rejected hyphens, so every ARC token minted with the deployed hyphenated scopes (`step-up:verify`, `app-enrollment:write`) threw `Invalid scope format` at sign time — the Flow B leave-Pulse fan-out was broken end-to-end. Pattern now admits `-`; regression-tested round-trip.
  - **S-H1 (arc-key-scopes, prep-pr review) — mitigation** — osn-api stores `allowedScopes` per SERVICE (upsert = full replace) while pulse-api registers TWO keys under one serviceId; disjoint scope sets clobbered each other on every boot race / 24h rotation, randomly fail-closing either the graph bridge or Flow B. Both pulse registrations (graphBridge + outbound-arc) and the seed now carry the identical four-scope union, and the false "per-key isolation" comment is corrected. Real per-key scope storage is tracked in wiki/TODO.md.
  - **S-L1 (prep-pr review)** — osn-api's `requireArc` early exits (malformed token, unknown/revoked kid, registry scope denial) now record the shared `arc.token.verification` counter, mirroring the pulse receiver; infra (DB-query) failures are excluded from the counter.
  - **S-M1 (pulse-onboarding)** — dedicated `graph:resolve-account` ARC scope gates `GET /graph/internal/profile-account` (least privilege on the profileId → accountId lookup). Granted to pulse-api (self-registration + seed) and cire-api (runbook); a `graph:read`-only token now gets 401 on that endpoint.
  - **S-L6 (account-deletion)** — Pulse `requireArc` now records the shared `arc.token.verification` counter on its early-exit branches (malformed / kid-unknown / kid-revoked / registry-scope-denied); new bounded `revoked_key` result value in `@shared/observability`.
  - **S-M4 (auth)** — `loadJwtKeyPair` asserts the imported `OSN_JWT_PRIVATE_KEY` carries the `sign` usage, failing at boot when the public JWK is pasted into the private slot.
  - **S-L5 (auth)** — boot-time assertion that `OSN_ORIGIN` is set in non-local envs (mirrors the CORS fail-closed guard) instead of silently falling back to the localhost WebAuthn origin.
  - **M3 (Copenhagen)** — `EmailSchema` caps emails at 255 chars.
  - **Dead metric cleanup (pulse)** — `pulse.auth.jwks_cache.lookups` deleted (cache moved to `@shared/osn-auth-client`, uninstrumented); `pulse.events.create.duration` wired around `createEvent` via `withEventCreateDuration`; `pulse.events.host_cancelled.hard_delete` wired into `runEventCancellationSweep`.

## 0.17.2

### Patch Changes

- f4b9c6b: Upgrade oxlint to 1.70; satisfy tightened vitest rules — add toThrow messages and fix standalone-expect in test suites

## 0.17.1

### Patch Changes

- 5add635: Handle prefix search for co-host autocomplete.

  - `@osn/db`: add a B-tree index on `users.handle` (`users_handle_idx`) to back
    left-anchored `LIKE 'prefix%'` scans, with forward-only migration
    `0001_exotic_lady_vermin.sql`. DEPLOY: this migration must be applied to
    osn-db-prod manually at deploy time — it is NOT in CI's `deploy.yml`
    (`bun run --cwd osn/db db:migrate:prod`).
  - `@osn/api`: new ARC-gated `GET /graph/internal/profile-search?prefix=&limit=`
    (scope `graph:read`, audience `osn-api`, same guard as the sibling internal
    endpoints). Normalises the prefix like `profile-by-handle` (strips `@`,
    lowercases), requires a minimum prefix length of 2 (returns an empty list,
    not an error, below it), excludes tombstoned/soft-deleted accounts
    (`deletedAt IS NULL`), escapes `LIKE` wildcards in the user input, orders by
    handle, and hard-caps results at 10 (default 8). Returns
    `{ profiles: [{ id, handle, displayName, avatarUrl }] }`.

## 0.17.0

### Minor Changes

- dd2dad3: Regenerate the osn-db drizzle migration chain into a single clean baseline.

  The previous chain (`0000`–`0009`) had drifted from the live schema during the accounts/users refactor: no migration created the `accounts` table, yet `0003`/`0004`/`0005`/`0006`/`0009` referenced it, so the chain could not apply to a fresh D1 (tests/local had been running off the schema directly, masking the break). The osn D1s are empty and nothing is deployed, so the chain was squashed into a single `0000` baseline generated from `osn/db/src/schema/index.ts`. The baseline applies cleanly from scratch (all 15 tables incl. `accounts`) and `wrangler d1 migrations apply` now works for the osn-db dev/staging/prod databases.

### Patch Changes

- 5aa1594: osn-api runs on Cloudflare Workers (`export default { fetch, scheduled }`).

  `osn/api/src/index.ts` is now the workerd entry, mirroring cire's proven
  template: a per-isolate `cached` app, fail-closed 503 on missing
  bindings/vars, everything built from the request-scoped `env` binding (not
  module-top `process.env`), and a cron `scheduled` handler that runs the
  account-erasure fan-out-retry + hard-delete sweeps (replacing the Bun
  `setInterval`). The Bun dev server moved into `src/local.ts` and is unchanged
  in behavior (default `bun run dev`); a runtime-agnostic `src/build-deps.ts`
  holds the shared composition both entries call.

  Highlights:

  - S-L1: the Workers Redis path env-gates the in-memory fallback — a deployed
    Worker (`OSN_ENV` set & != "local") with missing Upstash bindings fails
    closed at construction instead of silently downgrading rate-limiters /
    step-up-jti to per-isolate in-memory.
  - P-I3: the Upstash client + Effect runtime + Elysia app are built once per
    isolate and cached, never reconstructed in the request path.
  - S-H3: the Workers entry re-applies the `x-request-id` sanitize-and-echo the
    omitted observability plugin used to do.
  - Secrets (`INTERNAL_SERVICE_SECRET`, `PULSE_API_URL`/`ZAP_API_URL`) are
    threaded through `env`/the `createApp` factory instead of module-top
    `process.env` reads, since workerd surfaces secrets only on `env`.
  - `createApp` gains an `aot` flag (Workers passes `false`; AOT's `new
Function` is forbidden on workerd) and keeps `includeObservabilityPlugin:
false` + the redacting `osnLoggerLayer` on the Workers path.

  `@osn/db` / `@shared/db-utils`: `DbLive`'s bun:sqlite path is resolved lazily
  (`makeDbLive` now accepts a path thunk) so `fileURLToPath(import.meta.url)` no
  longer runs at module load — it threw on workerd, where `import.meta.url` is
  undefined, even though the Workers path never builds the bun:sqlite layer.

  wrangler.toml gains `main`, the real per-env D1 ids, per-env `[vars]`, and a
  6-hourly `[triggers] crons` for the sweeper. New devloop scripts: `dev`
  (unchanged fast Bun loop), `dev:wrangler` (workerd + local D1 + in-memory
  Redis, no external services), `deploy`, `types`, `build`.

- Updated dependencies [5aa1594]
  - @shared/db-utils@0.3.1

## 0.16.0

### Minor Changes

- f466a65: Migrate Pulse and the OSN core DB layer onto the four-environment database story
  (local bun:sqlite / dev·staging·prod D1). D1 has no interactive transaction, so
  every `db.transaction(async tx => …)` is rewritten to the shared `commitBatch`
  helper — an atomic `db.batch([...])` on D1, sequential awaited writes on
  bun:sqlite — preserving all-or-nothing semantics on the deployed driver.

  `@pulse/api`: 5 account-erasure transactions → `commitBatch`; `createApp`
  factory (`aot: false`) + `local.ts` (Bun.serve) + Workers `index.ts` (D1) +
  `wrangler.toml` (dev/staging/production) + a Miniflare integration test.

  `@osn/api`: all 17 transactions across auth / profile / graph / organisation /
  account-erasure → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants
  (UNIQUE-constraint guards for handle/email races; a count-guarded conditional
  DELETE for the last-passkey invariant). Adds a Miniflare integration test and a
  `wrangler.toml` for D1 migration tooling. NOTE: full Workers _hosting_ of
  osn-api remains gated on replacing ioredis with a Workers-compatible Redis —
  its DB layer is D1-ready but it still runs only as the Bun.serve `local` host.

  `@pulse/db` / `@osn/db`: broadened service `Db` type + `makeDbD1Live`,
  schema-reflection `./testing` export, and wrangler-based `db:migrate:*` scripts.

### Patch Changes

- Updated dependencies [f466a65]
  - @shared/db-utils@0.3.0

## 0.15.1

### Patch Changes

- 77f91a4: Local DB dev tooling — `db:reset` across the monorepo:

  - Root `bun run db:reset` resets every app DB; `osn/db`, `pulse/db`, `zap/db`
    each wipe their sqlite file → `db:push` → seed (seed skipped where no seed
    file exists, without swallowing real seed failures).
  - `cire/db` `db:seed` now runs `scripts/cire-db-seed.sh`, which seeds the local
    D1 and re-points the bootstrap wedding owner from `CIRE_DEV_OWNER_PROFILE_ID`
    (dev convenience — migration 0006 seeds the `usr_REPLACE_BEFORE_PROD`
    placeholder); `db:reset` = wipe D1 + push + seed.
  - `cire/db` drizzle.config points `db:studio` at the local miniflare D1 sqlite.
  - `cire/api` local dev server (`local.ts`) re-points the bootstrap wedding owner
    from `CIRE_DEV_OWNER_PROFILE_ID` so the signed-in account owns it (the dev
    server uses an in-memory seeded DB, not the persistent D1).

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

## 0.15.0

### Minor Changes

- c3cca40: Account deletion compliance (C-H2 / GDPR Art. 17).

  Two flows:

  - **Flow A — full OSN account delete.** New `DELETE /account` on osn-api with step-up gate, 7-day soft-delete grace + manual fast-track, ARC fan-out to currently-enrolled apps, hard-delete sweeper.
  - **Flow B — leave Pulse.** New `DELETE /account` on pulse-api with step-up verification round-trip to osn-api. Hosted events flip into a 14-day public cancellation window before hard-delete (audience commitment, independent of the 7-day account grace).

  Schema additions:

  - `osn/db`: `accounts.deleted_at`, `accounts.processing_restricted_at`, new `app_enrollments` (modular-platform opt-in tracking) and `deletion_jobs` (in-flight tombstones with per-bridge `*_done_at`).
  - `pulse/db`: `events.cancelled_at` / `hard_delete_at` / `cancellation_reason`, new `pulse_deletion_jobs`.

  Other surfaces:

  - New step-up token `purpose` claim (`account_delete`, `pulse_app_delete`) — confused-deputy guard for cross-service flows.
  - New osn-api internal endpoints: `/internal/step-up/verify`, `/internal/app-enrollment/{join,leave}`. ARC scopes `step-up:verify`, `app-enrollment:write`, `account:erase` added to the register-service allowlist.
  - Pulse becomes an ARC verifier (in-memory key registry + `/internal/register-service`) and an ARC issuer for the leave-app callback.
  - New observability: `osn.account.deletion.{requested,completed,duration,fanout,fanout_pending_age}`, `osn.account.app_enrollment.{joined,left}`, `pulse.account.deletion.*`, `pulse.events.host_cancelled[.hard_delete]`.
  - New `osn/client` SDK methods: `deleteAccount`, `cancelAccountDeletion`, `getAccountDeletionStatus`.

## 0.14.2

### Patch Changes

- 073238d: Migrate close friends from OSN core to Pulse.

  Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
  app can implement its own close-friends-style list against the OSN connection
  graph; OSN core retains only `connections` and `blocks`.

  What it does in Pulse:

  - **Feed boost.** Events organised by a close friend surface higher in
    `listEvents` (stable partition: chronological order preserved within each
    bucket; not applied for anonymous viewers).
  - **Hosting affordance.** The existing RSVP avatar ring — driven by an
    attendee having marked the viewer as a close friend — is preserved end-to-end,
    now backed by the local `pulse_close_friends` table.
  - **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
    header avatar dropdown).

  Surface changes:

  - New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
    routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
    `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
  - Removed: OSN-core `close_friends` table, services, routes (user-facing
    `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
    graph close-friend SDK methods on `@osn/client`, the close-friends tab in
    `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
    and the `GraphCloseFriendAction` observability attribute.
  - Connection projection now includes `id` so cross-DB references (Pulse adding
    by profile id) work without duplicating handle→id resolution.

  Pre-launch: the OSN `close_friends` table is dropped outright; seed data
  updated. No migration path or backwards-compatibility shims.

## 0.14.1

### Patch Changes

- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
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

- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @shared/db-utils@0.2.3

## 0.14.0

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

## 0.13.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

## 0.12.0

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

## 0.11.0

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

## 0.10.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

## 0.9.0

### Minor Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

## 0.8.0

### Minor Changes

- fe55da8: Implement kid-based ARC key auto-rotation. Adds service_account_keys table (per-key rows, zero-downtime rotation). ArcTokenClaims now requires a kid field (JWT header). resolvePublicKey now takes (kid, issuer, scopes). pulse/api auto-rotates ephemeral keys via startKeyRotation(). Migrates pulse/api graph bridge from in-process imports to ARC-token authenticated HTTP calls against /graph/internal/\* endpoints.

## 0.7.2

### Patch Changes

- a723923: feat(core): Multi-account P6 — Privacy audit

  - Add `passkeyUserId` column to `accounts` table (random UUID, generated at account creation) to prevent WebAuthn-based profile correlation — passkey registration now uses this opaque ID instead of `accountId` as the WebAuthn `user.id`
  - Add `accountId` / `account_id` to the observability redaction deny-list as defence in depth against log-based correlation
  - Add privacy invariant test suite verifying `accountId` never leaks in API responses, token claims, or profile data
  - Audit confirmed: all route responses, span attributes, metric attributes, and rate limit keys are clean

## 0.7.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.

## 0.7.0

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

## 0.6.0

### Minor Changes

- e2ef57b: Add organisation support with membership and role management

## 0.5.3

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @shared/db-utils@0.2.2

## 0.5.2

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

## 0.5.1

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
  - @shared/db-utils@0.2.1

## 0.5.0

### Minor Changes

- 45248b2: feat(crypto): ARC token system for service-to-service authentication

  - ES256 key pair generation (`generateArcKeyPair`)
  - JWT creation and verification (`createArcToken`, `verifyArcToken`)
  - Scope validation and audience enforcement
  - Public key resolution from `service_accounts` DB table (`resolvePublicKey`)
  - In-memory token cache with 30s-before-expiry eviction (`getOrCreateArcToken`)
  - JWK import/export utilities
  - `service_accounts` table added to `@osn/db` schema
  - 16 tests covering all functions

- 45248b2: feat: expand seed data with 20 users, social graph, event RSVPs

  - osn-db: 20 seed users with 25 connections and 3 close friends
  - pulse-db: `event_rsvps` table for tracking attendance
  - pulse-db: 15 seed events across 8 creators with 72 RSVPs
  - Fix effect version alignment across all packages (resolves pre-existing type errors)

## 0.4.0

### Minor Changes

- 623ad9f: Add social graph data model: connections, close friends, blocks.

  `@osn/db` — three new Drizzle tables: `connections` (pending/accepted requests), `close_friends` (unidirectional inner circle), `blocks` (unidirectional mutes/blocks). Exported inferred types for each.

  `@osn/core` — new `createGraphService` (Effect.ts, all graph operations) and `createGraphRoutes` (JWT-authenticated Elysia routes). Endpoints under `/graph/connections`, `/graph/close-friends`, `/graph/blocks`.

## 0.3.0

### Minor Changes

- 9caa8c7: Add user handle system

  Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

  - **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
  - **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
  - **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
  - **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility

## 0.2.3

### Patch Changes

- 05a9022: Add event ownership enforcement: `createdByUserId NOT NULL` on events, auth required for POST/PATCH/DELETE, ownership check (403) on mutating operations, `createdByName` derived server-side from JWT email claim, index on `created_by_user_id`, `updateEvent` eliminates extra DB round-trip.

## 0.2.2

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

## 0.2.1

### Patch Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

## 0.2.0

### Minor Changes

- 880e762: Split `packages/db` into `packages/osn-db` (`@osn/db`) and `packages/pulse-db` (`@pulse/db`). Each app now owns its database layer: OSN Core owns user/session/passkey schema, Pulse owns events schema. Replace Valibot with Effect Schema in the events service — `effect/Schema` is used for service-layer domain validation and transforms (e.g. ISO string → Date), while Elysia TypeBox remains at the HTTP boundary for route validation and Eden type inference.

### Patch Changes

- 880e762: Add `@utils/db` package (`packages/utils-db`) with shared database utilities — `createDrizzleClient` and `makeDbLive` — eliminating boilerplate duplication between `@osn/db` and `@pulse/db`. Both db packages now delegate client creation and Layer setup to `@utils/db`. Also removes the unused singleton `client.ts` export from both db packages.
- Updated dependencies [880e762]
  - @utils/db@0.2.0
