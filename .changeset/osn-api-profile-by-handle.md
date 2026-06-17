---
"@osn/api": minor
---

Add an ARC-gated internal endpoint `GET /graph/internal/profile-by-handle` that
resolves an OSN handle (e.g. `@alice`) to its profile id (plus handle +
display name), or 404. Requires audience `osn-api` + scope `graph:read`, mirrors
the existing `/profile-account` route, and applies the same tombstone rule (a
soft-deleted account is invisible during the grace window). Handle input is
normalised (strips a leading `@`, lowercases) before the exact-match lookup.

Consumed by cire to turn an organiser-typed handle into a `usr_*` id when adding
a wedding co-host — cire has no other way to map a handle to a profile id.
