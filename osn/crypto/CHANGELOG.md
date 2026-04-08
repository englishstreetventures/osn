# @osn/crypto

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
