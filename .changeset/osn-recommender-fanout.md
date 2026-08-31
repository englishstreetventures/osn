---
"@osn/api": patch
"@osn/client": patch
---

Connection recommendations (`GET /recommendations/connections`):

- **Fixed** (osn-tracker#574): the organisation co-member fan-out was one query
  bounded by a single global row cap, ordered by organisation id — so whichever
  organisation the caller happened to belong to sorted first absorbed the whole
  budget, and every other organisation contributed nothing, permanently (50
  organisations of 250 members each, only ~8 ever won). The fan-out is now a
  `UNION ALL` of a per-organisation subselect each bounded by its own share of
  the budget, so every organisation the caller belongs to contributes
  candidates.
- **Fixed** (osn-tracker#589, P-C1 — the fix above's own regression): that
  `UNION ALL` was one statement for up to 50 organisations, which throws on
  real D1 for any caller in 6 or more — D1 runs on workerd's embedded SQLite,
  capped at 5 terms in a compound `SELECT`, not the 500-term default
  `bun:sqlite` (and the original comment) assumed. The fan-out now runs in
  batches of at most 5 organisations per statement, executed concurrently and
  merged in application code, so a caller in any number of organisations up to
  the 50-organisation cap gets a result instead of a 500.
- Added `generatedAt` (ISO 8601) to the response, alongside `suggestions`, so a
  client can tell how fresh a list is (osn-tracker#311, timestamp half only —
  the cache half is a separate, undecided change). `@osn/client`'s
  `suggestConnections` return type carries the new field.
