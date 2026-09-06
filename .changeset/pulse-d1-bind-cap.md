---
"@shared/db-utils": patch
"@pulse/api": patch
---

Stop six pulse queries binding one parameter per element against D1's cap.

D1 allows 100 bound parameters per query. A `SELECT` binding an id list broke
past 50-100 items; a multi-row `INSERT`, which binds one parameter per column
per row, broke an order of magnitude sooner. Six sites were affected, and three
were live: recurring series failed to materialise past three instances, the RSVP
list broke for every viewer of a well-attended event, and a GDPR erasure could
never complete for an account that had hosted more than a hundred events.

`@shared/db-utils` gains `jsonEachIn` and `insertManyViaJsonEach`, which bind the
whole array as one JSON parameter and unpack it inside SQLite with `json_each`.
Both are verified against real Miniflare-backed D1 rather than bun:sqlite, which
enforces no such cap and so passes against every one of these bugs.
