---
"@cire/api": patch
"@cire/db": patch
---

Performance: migration 0026 replaces the dead `events_sort_order_idx` and the
single-column `events_wedding_idx` with a composite
`events_wedding_id_sort_idx (wedding_id, sort_order)`, serving every
wedding-scoped events read's filter + order from one B-tree and dropping a
dead index's write cost on the import path. The cire/api test-DDL lockstep
mirror is updated to match.
