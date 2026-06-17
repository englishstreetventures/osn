---
"@cire/api": minor
"@cire/organiser": minor
---

Let organisers host **multiple** weddings. The organiser portal now lands on a
wedding list/selector with an inline create form instead of hardcoding the
first owned wedding; selecting one opens the existing tabbed guests/events/invite
dashboard scoped to that `weddingId`.

Backend: a new `POST /api/organiser/weddings` (gated by `osnAuth()` alone; owner
taken from the verified token, never the body) creates a wedding via
`weddingsService.createForOwner` — server-generated `wed_<uuid-hex>` id, a unique
slug derived from the display name plus a random suffix, default `secure` code
style — and emits the `cire.wedding.created` metric. The single-owned-wedding
`ownedWedding()` middleware (which 400'd once a caller owned more than one) is
removed; the import routes moved from `/api/organiser/import/*` to
`/api/organiser/weddings/:weddingId/import/{preview,apply,revert,list}` under
`weddingOwner()`, so an organiser who owns several weddings picks the target
explicitly in the URL. The bootstrap wedding simply appears in the list and opens
its dashboard as before.
