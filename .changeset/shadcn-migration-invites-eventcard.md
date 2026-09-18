---
"@cire/invites": patch
---

Drop an inert `sm:py-2.5` from the RSVP button on the guest site's event card.

The button is `min-h-11` unprefixed — 44px at a 16px root, 46.75px at the 17px
root cire sets above 1024px. cire's `md` button is `px-4 py-2 text-ui-sm` plus a
border, `--ui-text-sm` is `0.82rem`, and the contract declares no
`--text-ui-sm--line-height`, so line-height inherits `body`'s 1.5. The content
box comes to 37.7px with `py-2` and 41.7px with `py-2.5` at a 16px root, 39.9px
and 44.2px at 17px. The min-height wins in all four, so the padding never
reached the painted height.

Everything is in `rem`, so a root-size change cannot break that inequality, and
the claim holds for any inherited leading below about 1.68. The sibling raw
`<button>` this was presumably matching is pinned by its own `min-h-11`, so the
two still agree.
