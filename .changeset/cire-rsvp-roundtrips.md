---
"@cire/api": patch
---

Cut two D1 round-trips off `POST /api/rsvp`.

The guest-ownership check and the invitation lookup were two sequential reads
over the same rows; they are now one LEFT JOIN, still keyed only on the
authenticated `familyId` so the endpoint's ownership guarantee is unchanged.
That join and the family/deadline join no longer wait on each other — they run
under `Effect.all({ concurrency: "unbounded" })`. Six round-trips down to four
per submit. P-W1.
