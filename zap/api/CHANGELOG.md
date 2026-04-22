# @zap/api

## 0.3.16

### Patch Changes

- Updated dependencies [811eda4]
  - @shared/observability@0.5.2

## 0.3.15

### Patch Changes

- Updated dependencies [58e3e12]
  - @shared/observability@0.5.1

## 0.3.14

### Patch Changes

- Updated dependencies [dc8c384]
  - @shared/observability@0.5.0

## 0.3.13

### Patch Changes

- Updated dependencies [9459f5e]
  - @shared/observability@0.4.0

## 0.3.12

### Patch Changes

- Updated dependencies [2d5cce9]
  - @shared/observability@0.3.3

## 0.3.11

### Patch Changes

- Updated dependencies [2a7eb82]
  - @shared/observability@0.3.2

## 0.3.10

### Patch Changes

- Updated dependencies [0edef32]
  - @shared/observability@0.3.1

## 0.3.9

### Patch Changes

- 1d9be5a: Extract `createRateLimiter`, `getClientIp`, and `RateLimiterBackend` into a new `@shared/rate-limit` package. `@zap/api` now imports directly from `@shared/rate-limit` and no longer depends on `@osn/core`.
- Updated dependencies [1d9be5a]
  - @shared/rate-limit@0.2.0

## 0.3.8

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/core@0.17.0

## 0.3.7

### Patch Changes

- Updated dependencies [d691034]
  - @osn/core@0.16.4

## 0.3.6

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @shared/observability@0.3.0
  - @osn/core@0.16.3

## 0.3.5

### Patch Changes

- Updated dependencies [42589e2]
  - @shared/observability@0.2.10
  - @osn/core@0.16.2

## 0.3.4

### Patch Changes

- Updated dependencies [a723923]
  - @osn/core@0.16.1
  - @shared/observability@0.2.9

## 0.3.3

### Patch Changes

- Updated dependencies [8137051]
  - @osn/core@0.16.0
  - @shared/observability@0.2.8

## 0.3.2

### Patch Changes

- Updated dependencies [33e6513]
  - @osn/core@0.15.0
  - @shared/observability@0.2.7

## 0.3.1

### Patch Changes

- Updated dependencies [5520d90]
  - @osn/core@0.14.1

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
  - @osn/core@0.14.0
  - @zap/db@0.3.0
  - @shared/observability@0.2.6

## 0.2.2

### Patch Changes

- Updated dependencies [e2ef57b]
  - @osn/core@0.13.0
  - @shared/observability@0.2.5

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/core@0.12.1
  - @shared/observability@0.2.4
  - @zap/db@0.2.1

## 0.2.0

### Minor Changes

- 7349512: Add Zap messaging backend with chat and message services for event chat integration

  - Create `@zap/db` package with chats, chat_members, and messages schema (Drizzle + SQLite)
  - Create `@zap/api` package with Elysia server (port 3002), chat/message REST routes, Effect services, and observability metrics
  - Add `chatId` column to Pulse events schema for event-chat linking
  - Add `zapBridge` service in Pulse for provisioning event chats and managing membership

### Patch Changes

- Updated dependencies [7349512]
  - @zap/db@0.2.0
