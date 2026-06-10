---
"@cire/db": minor
"@cire/api": patch
---

Scaffold multi-tenancy: new `weddings` table, FKs from `families`,
`events`, `imports`. Bootstrap row seeded by migration 0006 with a
placeholder owner id (substituted with the real OSN profile id before
the remote D1 push). Single-owner today; join-table for multi-owner
deferred.
