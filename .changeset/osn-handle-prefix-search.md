---
"@osn/db": patch
"@osn/api": patch
---

Handle prefix search for co-host autocomplete.

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
