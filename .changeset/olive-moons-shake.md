---
"@osn/api": patch
---

Halve the rows the connection-suggestion fan-out reads, and stop it labelling a suggestion with an organisation that no longer exists.

`suggestConnections` fanned out to up to 2,000 organisation co-members and joined `organisations` on each row — a primary-key probe per membership row, so roughly 4,000 rows read where the query needed 2,000. D1 bills rows read. The fan-out now selects ids only, and the organisations that survive ranking (at most 50, usually far fewer) are hydrated in the same concurrent step as the profiles, so the request costs no extra round trip.

The fan-out also gains `ORDER BY (organisation_id, profile_id)`. That pins what was left to the planner rather than fixing an observed problem: SQLite already walked `org_members_pair_idx` in exactly this order, so the plan is identical either way and no behaviour changes today. The index is UNIQUE on those two columns, so the ordering is its own and adds no sort.

A candidate whose only basis was a shared organisation, and whose organisation has since been deleted, is now dropped rather than returned claiming `shared_organisation` with nothing to name — which is what the removed inner join used to do.
