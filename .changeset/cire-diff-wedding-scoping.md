---
"@cire/api": patch
---

Scope `diffAgainstDb` to a single `weddingId` so spreadsheet imports are
tenant-isolated. `events` / `families` filter on their `wedding_id`
column; `guests` / `guest_events` (which carry no `wedding_id`) are
reached by an inner join through `families` — the link-table join is
load-bearing, since a per-table `WHERE wedding_id = ?` couldn't scope
`guest_events` and would read another wedding's links as removals. The
interim `MultiWeddingImportUnsupported` fail-closed tripwire (and its 409
route mapping) is removed; preview / apply / revert now run safely with
more than one wedding present.
