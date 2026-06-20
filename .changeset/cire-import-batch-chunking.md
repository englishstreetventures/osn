---
"@cire/api": patch
---

Chunk `applyImport`'s D1 write set so a large guest list can't exceed D1's
per-Worker-invocation query cap.

- `applyImport` previously committed its entire FK-ordered write set as a
  single `db.batch([...])`. Every statement in a batch counts as one query
  against D1's per-invocation cap (50 on the Free tier cire runs on, 1000 on
  Paid), so a few-hundred-row diff would blow past it. `commitWriteSet` now
  splits the ordered statement list into sequential chunks of
  ≤`MAX_STATEMENTS_PER_BATCH` (50) and awaits each `batch()` in order.
- Dependency ordering is preserved: the statement list is built in strict
  FK order (removes → event/family/guest creates → updates → link removes →
  link creates) and chunks are awaited serially, so a chunk boundary can
  never run a child insert before its parent. The bun:sqlite path (no
  `.batch()`) is unchanged — sequential awaited statements.
- Atomicity is now per-chunk, not whole-import: D1 has no multi-batch
  transaction, so a mid-import failure can leave a partial apply. This is the
  accepted tradeoff — `services/revert.ts` already reconciles a partial apply
  by re-diffing the prior import's CSVs and re-applying. No cross-batch
  transaction machinery was added.
- New `src/db/d1-integration.test.ts` case builds a 120-statement diff
  (40 families × family + guest + link) against a real Miniflare D1, asserts
  the batch is dispatched as ceil(120/50) = 3 chunks (50/50/20), and that
  every row — including guest_events links whose parent guest insert lands in
  an earlier chunk — is applied correctly.
