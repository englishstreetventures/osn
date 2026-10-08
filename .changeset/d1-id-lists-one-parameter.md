---
"@osn/api": patch
"@pulse/api": patch
"@zap/api": patch
---

Queries that filter by a list of ids now bind the list as one JSON parameter (`jsonEachIn`) instead of one parameter per id, so their parameter count no longer grows with the list and cannot pass D1's limit of 100: in `@osn/api` the profile and organisation search probes, the graph list hydrations, the profile-display batch read, the account-email lookup and the erasure, export and passkey reads; in `@pulse/api` the data-subject export and the erasure batch; in `@zap/api` the export reads.

`@pulse/api`: `/internal/account-export` accepts at most 50 profile ids, the same cap as `/internal/account-deleted`, and answers 422 above it.
