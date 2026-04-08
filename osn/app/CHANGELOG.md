# @osn/osn

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
