---
"@cire/api": patch
"@cire/host": patch
---

Let a helper leave a wedding too.

`DELETE /api/organiser/weddings/:weddingId/hosts/me` moves from `weddingMember()`
to a new `weddingSeat()` gate that admits anyone holding a seat, whatever its
role; the owner is still refused with 409 `owner_cannot_leave`. The portal's
"Leave this wedding" control becomes its own component, `LeaveWedding`, and also
appears on the helper's run-sheet screen, since a helper never sees the co-host
panel.
