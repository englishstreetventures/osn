# @osn/social

## 0.2.7

### Patch Changes

- Updated dependencies [811eda4]
  - @osn/client@0.10.0
  - @osn/ui@0.10.0

## 0.2.6

### Patch Changes

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

- Updated dependencies [dc8c384]
  - @osn/client@0.9.0
  - @osn/ui@0.9.0

## 0.2.5

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/client@0.8.0
  - @osn/ui@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [2d5cce9]
  - @osn/client@0.7.0
  - @osn/ui@0.7.4

## 0.2.3

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/client@0.6.0
  - @osn/ui@0.7.3

## 0.2.2

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/client@0.5.1
  - @osn/ui@0.7.2

## 0.2.1

### Patch Changes

- 6d0eb83: Ask for confirmation before removing a friend to prevent accidental removals.

## 0.2.0

### Minor Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/client@0.5.0
  - @osn/ui@0.7.1
