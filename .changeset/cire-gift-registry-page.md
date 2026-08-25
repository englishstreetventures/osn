---
"@cire/api": patch
"@cire/invites": patch
---

Give the gift list its own page at `/<slug>/registry`, and leave a band on the
invite that links to it.

The list used to be the last section of the invite. It is the one part of an
invitation a guest comes *back* to — to see what is still free, to change what
they reserved, to open it in a shop — and none of that should mean scrolling the
whole invitation again. It is also, now, a link a couple can send on its own.

**The list is for the couple's guests.** `GET /api/invite/:slug/registry` used to
be public; it now sits behind the same `cire_session` the rest of the invitation
does. A gift list names what a couple want and what it costs, and they only ever
showed it to the people they invited. `registryGuestService.guestView` checks the
family against the WEDDING, not merely that it exists — a session names a
household, not a wedding, so without that one leaked code would open every
couple's list on the platform; a family from another wedding gets the same 404 as
an unpublished one. The gift *image* route stays unauthenticated: the names are
per-save uuids reachable only from the gated list, and a session lookup per image
is the one place on the guest surface where requests arrive in dozens.

**The route** (`pages/[slug]/registry.astro`) reads the invite server-side, which
is public, so the page paints as the couple's immediately. The list cannot be
read there at all — the session cookie is host-scoped to the API origin, so the
guest Worker never receives it — so the island makes that read and its answer
decides the page: the list, "this gift list is for the couple's guests" with a
way to the invitation, or "the couple have closed their gift list". The only 404
the route answers is an unknown wedding; anything more would answer, to anyone
holding a slug, the question the API's single 404 code exists to refuse.

**The page** (`GiftRegistryDocument.astro` + `GiftRegistryPage.tsx`) is one shell
for both design packs — the gift surfaces were always shared, and the couple's
colours, faces and section tone are what make it theirs. A sticky rail carries
the way back to the invitation; the masthead is a band, not a second hero, over
the invite's own hero image at the same URL (already cached for a guest who came
from it). Above the list, a ledger line: what is still available, and what this
household has reserved. The list itself is grouped into shelves by the couple's
own categories, in their own order, with anything ungrouped last — and no labels
at all when they grouped nothing.

**The band** (`GiftRegistryTeaser.tsx`) replaces the section on the invite:
the same heading and intro, a peek at up to four gifts that have pictures, the
link, and the availability line. It renders nothing for a wedding with no
published list, and nothing for a visitor who has not entered their code — the
same silence every other claim-gated section keeps, rather than advertising a
page that would turn them away. Both it and the page listen for
`CLAIM_SESSION_EVENT`, so a claim opens them in place with no reload.

Behaviour that did not change: counts and never names, no optimistic updates, the
409 race refetching and saying so with the guest's form left open, the household
read gated on the claim hint. Two things did: a failed re-read now leaves the
list on screen rather than blanking it (as a page, blanking is the whole page),
and blank organiser copy counts as unset rather than beating the fallbacks.
