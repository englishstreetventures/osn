---
"@shared/ui": minor
---

New `Modal`, built on the platform's `<dialog>` + `showModal()` rather than on
Kobalte.

**The choice was a measurement, not a preference.** `@cire/invites` and
`@cire/landing` carry no Kobalte, and importing `@kobalte/core/dialog` costs
**15.3 KB gzip** on top of a bare Solid bundle (2,270 → 17,564 bytes) against
**~11.7 KB of headroom** in each — so a Kobalte-backed shared Modal does not
fit in either, and adopting it would mean re-baselining the guest site's budget
by roughly 9% on the surface people load on mobile data at a wedding.

Most of that 15 KB buys behaviour the browser now does natively: `showModal()`
gives a focus trap, Escape-to-close, background inertness and a `::backdrop`
pseudo-element. What remains is reactive open/close, a backdrop-click that does
not misfire, and the accessible name.

**The top layer is the substantive win.** A `showModal()` dialog renders outside
the normal flow, so it is immune to the trap that already cost this repository a
bug: a `transform` on any ancestor becomes the containing block for
`position: fixed` descendants *and* a stacking context no `z-index` escapes.
Motion One leaves its final inline `transform` on everything it animates, which
is what put cire's RSVP toast under the sheet it fired beneath. All nine
hand-rolled overlays here are `position: fixed` in a portal, each one an animated
ancestor away from that. A browser test renders the Modal inside a transformed,
`z-index: 2147483647` ancestor and asserts it is still the topmost element at its
own centre — the bug class stops being possible rather than being avoided by
convention.

`@musubi/social` and `@pulse/web` keep the existing Kobalte-backed `Dialog`;
nothing about it changes.

Also adds a browser test project to `@shared/ui`. Almost everything worth having
about `<dialog>` is unobservable in a DOM shim — the top layer, the focus trap,
inertness, `::backdrop` — so a shim assertion that the element exists would pass
just as happily against a `<div>` wearing the same classes.
