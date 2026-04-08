# @osn/crypto

## 0.1.1

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
  - @osn/db@0.5.1

## 0.1.0

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

### Patch Changes

- Updated dependencies [45248b2]
- Updated dependencies [45248b2]
  - @osn/db@0.5.0
