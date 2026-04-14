---
"@osn/core": minor
"@shared/observability": patch
---

feat: Profile CRUD (multi-account P3) — create, delete, set default

Adds `createProfileService()` with three operations:
- `createProfile`: creates a new profile under an existing account, enforces `maxProfiles` limit (fixes S-L1), validates handle against both user and org namespaces
- `deleteProfile`: cascade-deletes all profile-owned data (connections, close friends, blocks, org memberships) in a single transaction, guards against deleting the last profile or org-owning profiles
- `setDefaultProfile`: changes which profile is the default for token refresh

Three new REST routes: `POST /profiles/create`, `POST /profiles/delete`, `POST /profiles/:profileId/default` with per-endpoint rate limiting (5/min create+delete, 10/min set-default).

Observability: `ProfileCrudAction` bounded union, `osn.profile.crud.operations` counter, `osn.profile.crud.duration` histogram, `withProfileCrud` span+metric wrapper.

Resolves S-L1 (maxProfiles enforcement) and S-L2 (email dedup confirmed clean).
