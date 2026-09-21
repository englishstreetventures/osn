---
"@cire/invites": patch
---

#683 — both design packs' islands ran their own copy of the on-mount no-store
revalidation of `GET /api/invite/:slug`, four in all. They now share
`createInviteRevalidation` (`cire/invites/src/components/invite-revalidation.ts`),
which owns the fetch, the `no-store`, the `initialValue` wiring, the
no-slug short-circuit and both failure paths. It is parameterised rather than
lifted: the headers and the pages were never the same block — a header takes the
payload unmapped and falls back to its whole `initial` prop, a page maps three
fields out of it and falls back to a value built from three props — so each call
site still passes its own `fallback()` and `select()`. The wire-shape types
(`InviteCustomisationResponse`, `DetailsCopy`), previously declared privately in
each `InvitePage`, move to the shared module; the always-redacted `footer` field
goes, since `GET /api/invite/:slug` nulls it and nothing read it.

#684 — gala's `InviteHeader` gains the two title-panel cases classic already had,
plus the hero-display clamp cases neither pack covered: an over-range opacity
pins to 100%, an over-range blur to 20px, and a non-numeric value falls to the
default.
