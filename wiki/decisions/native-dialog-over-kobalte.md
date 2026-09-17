---
title: "Modal on the platform <dialog>, not Kobalte's"
tags:
  - decision
  - frontend
  - performance
  - accessibility
related:
  - "[[component-library]]"
  - "[[bundle-size-guards]]"
  - "[[frontend-patterns]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-17
---

# Modal on the platform `<dialog>`, not Kobalte's

`@shared/ui`'s `Modal` is built on the browser's own `<dialog>` element and
`showModal()`, even though the same package already ships a Kobalte-backed
`Dialog`. Two things decided it: Kobalte does not fit inside the bundle budgets
of the two apps that would have to adopt it, and the top layer makes a bug class
impossible rather than merely avoided.

## The alternatives

| Option | What it is | Why not |
|---|---|---|
| Kobalte `Dialog` | `@kobalte/core/dialog`, already in `@shared/ui` and used by `@musubi/social` and `@pulse/web` | Does not fit the guest site's or the marketing site's bundle budget — see below |
| A hand-rolled overlay | `position: fixed` inside a portal, with a `z-index`, as nine other overlays in this repository do | Every one of them is one animated ancestor away from being captured by a `transform` |
| Platform `<dialog>` + `showModal()` | What shipped | — |

## What made the difference

### Bundle size, against apps that have no Kobalte at all

`@cire/invites` and `@cire/landing` carry no Kobalte in their bundles. Adding
it is not a marginal cost there — it is the whole library's entry price:

> Measured 2026-09-16, importing `@kobalte/core/dialog` costs **15.3 KB gzip**
> on top of a bare Solid bundle (2,270 → 17,564 bytes), against **~11.7 KB of
> headroom** in each of those two apps. Adopting it there would mean
> re-baselining the guest site's budget by roughly 9% — on the surface people
> load on mobile data at a wedding.

*Measured — `bun build <entry> --minify --target=browser` from `shared/ui`, with
and without the import, then `gzip -9`. Budgets in
`scripts/bundle-size-budgets.txt`.*

Re-baselining a budget upward to admit a dependency is exactly the move
[[bundle-size-guards]] exists to make deliberate, and there was nothing to
deliberate about: most of what the 15 KB buys is behaviour the browser now does
natively. `showModal()` supplies the focus trap, Escape-to-close, background
inertness and the `::backdrop` pseudo-element. What `Modal` adds on top is small
— reactive open/close, a close-on-backdrop-click that does not misfire, the
accessible name, and the deferred exit described in [[component-library]].

### The top layer removes a bug class rather than avoiding it

A `showModal()` dialog renders in the **top layer**, outside the normal flow. A
`transform` on any ancestor turns that ancestor into the containing block for
`position: fixed` descendants *and* into a stacking context no `z-index`
escapes. Motion One leaves its final inline `transform` on everything it
animates, which is what left cire's RSVP toast mispositioned and painted
underneath the sheet it fired beneath ([[frontend-patterns]]). The top layer
cannot be captured that way, so the failure stops being possible instead of
being avoided by convention — and the element needs no `z-index` and no portal.

## Which to reach for

| Reach for | When |
|---|---|
| `Modal` (`@shared/ui/ui/modal`) | The default. Any overlay in `@cire/*`, and anything that only needs to be a modal dialog |
| Kobalte `Dialog` (`@shared/ui/ui/dialog`) | In `@musubi/social` and `@pulse/web`, which already pay for Kobalte, when a dialog has to compose with other Kobalte parts — most concretely a `Popover` opened from inside it, which depends on Kobalte's `modal: true` `aria-hidden` walk and the `data-kb-top-layer` exemption on `PopoverContent` |

## What would make this worth revisiting

- Kobalte's dialog becomes separately importable at a cost that fits inside
  ~11.7 KB gzip, or the cire budgets grow for an unrelated reason that leaves
  that much room.
- `@cire/invites` or `@cire/landing` takes on Kobalte for something else, at
  which point the incremental cost of its dialog is no longer the entry price.
- A requirement appears that the top layer cannot serve — nested modals with
  independent dismissal, or a dialog that must be anchored rather than centred.

The measurement is the thing to re-run, not the argument: re-measure with the
method above before concluding anything has changed.
