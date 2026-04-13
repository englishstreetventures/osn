---
"@osn/db": minor
"@osn/core": minor
"@osn/client": minor
"@osn/ui": minor
"@pulse/db": minor
"@pulse/api": minor
"@pulse/app": minor
"@zap/db": minor
"@zap/api": minor
"@shared/observability": patch
---

feat: add multi-account schema foundation (accounts table, userId → profileId rename)

Introduces the `accounts` table as the authentication principal (login entity) and renames
`userId` to `profileId` across all packages to establish the many-profiles-per-account model.

Key changes:
- New `accounts` table with `id`, `email`, `maxProfiles`
- `users` table gains `accountId` (FK → accounts) and `isDefault` fields
- `passkeys` re-parented from users to accounts (`accountId` FK)
- All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
- Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
- Registration flow creates account + first profile atomically
