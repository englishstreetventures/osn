---
"@cire/api": patch
---

Count D1 queries that miss the per-request session. Each query prepared on the
raw binding, because no session was on the async context, now increments
`cire.d1.session_missing` (labelled `fetch` or `scheduled`). The first such
query per client also logs a warning. Such a query still gives the right
answer, since it goes to the primary, so without these signals nothing would
show that read replication had stopped applying to it.
