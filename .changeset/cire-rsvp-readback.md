---
"@cire/api": patch
---

Fold the `POST /api/rsvp` read-back into the write batch.

The endpoint committed its upserts and then read the household's rows back in a
second round-trip. New `commitGroupedBatchesReturning` helper carries a trailing
select through the same chunked `db.batch()` call — riding in the final chunk
where it fits, and shipping as its own trailing batch at the statement ceiling —
so the write and its read-back cost one round-trip instead of two. The read-back
is still keyed only on the authenticated `familyId`. `submitRsvps` and
`getRsvpsForFamily` keep their existing behaviour; both paths now build their
statements through shared helpers so they cannot drift apart. Proven over real
D1 in `test:d1`, the only environment where a batch can order or map results
wrongly. P-W1.
