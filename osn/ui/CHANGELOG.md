# @osn/ui

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

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/client@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [2d5cce9]
  - @osn/client@0.7.0

## 0.7.3

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/client@0.6.0

## 0.7.2

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/client@0.5.1

## 0.7.1

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/client@0.5.0

## 0.7.0

### Minor Changes

- e2f4c25: Add DropdownMenu component to @osn/ui; redesign Pulse header with full-width layout, expanding create-event button, and avatar dropdown menu

## 0.6.0

### Minor Changes

- d691034: Add 6-digit OTP input component with visual status states and fix login endpoints to return snake_case OAuth token format.

## 0.5.2

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.

## 0.5.1

### Patch Changes

- aa256af: Inline base: variant prefixes for Tailwind v4 JIT compatibility; add cursor-pointer to Button; deprecate bx(). Add @source directive for UI library scanning; wrap auth forms in Dialog modals with mutual exclusion.

## 0.5.0

### Minor Changes

- 33c6ba6: Multi-account P5: Profile UI components

  Add ProfileSwitcher (popover with profile list, switch, delete, create), CreateProfileForm, and ProfileOnboarding components to @osn/ui. Integrate ProfileSwitcher into Pulse event list header and ProfileOnboarding into Pulse settings page.

## 0.4.2

### Patch Changes

- Updated dependencies [fcd8e8f]
  - @osn/client@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies [f2fbc2a]
  - @osn/client@0.3.2

## 0.4.0

### Minor Changes

- 7030545: Migrate UI components to Zaidan (shadcn-style component library for SolidJS)

  Adds Kobalte-backed headless UI primitives (Button, Input, Label, Card, Badge, Dialog, Popover, Tabs, RadioGroup, Checkbox, Textarea, Avatar) to @osn/ui as the shared design system. Replaces inline Tailwind class patterns across both @osn/ui auth components and @pulse/app with these reusable primitives.

## 0.3.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.
- Updated dependencies [5520d90]
  - @osn/client@0.3.1

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

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/client@0.3.0

## 0.2.2

### Patch Changes

- 098fd01: Upgrade vite from v6 to v8 with devtools, bump astro to 6.1.5

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/client@0.2.1

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

- 97f35e5: Fix Register form showing "1–30 chars…" format error when the OSN handle availability check fails for network/server reasons. The local regex check already runs before the fetch, so any thrown error from `checkHandle` is by definition not a format problem; it now surfaces as a distinct "Couldn't check availability — try again" message instead of misleadingly blaming the user's input.
- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/client@0.2.0
