---
title: "Nothing ranks against a sheet: the top layer, not a bigger number"
tags:
  - decision
  - cire
  - frontend
related:
  - "[[cire]]"
  - "[[toast]]"
  - "[[cire-consent]]"
  - "[[native-dialog-over-kobalte]]"
  - "[[component-library]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-17
---

# Nothing ranks against a sheet: the top layer, not a bigger number

`cire/invites/src/lib/z-index.ts` is the guest site's stacking scale, and the
notable thing about it is what it does **not** contain: there is no `MODAL`
layer, and nothing in it claims to sit above one.

The details and RSVP sheets are `@shared/ui`'s `Modal` — a `<dialog>` opened
with `showModal()` — and such a dialog paints in the **top layer**, above every
stacking context in the document by definition, whatever number anything else
carries. So the two things in this app that must appear over a sheet get there
by **entering the top layer after it**, not by out-numbering it. Top-layer order
is entry order.

| Element | How it clears a sheet | What its `z-index` still does |
|---|---|---|
| Add-to-Calendar menu | `popover` + `showPopover()`, shown after the sheet opened | `MODAL_POPOVER` (110) — the same menu opened from an event card, where it competes with the page |
| Toast container | `@shared/toast`'s `topLayer`, which shows the container as a popover as the first toast arrives | `TOAST` (150) — everything not in the top layer, the consent banner above it included |
| Consent preferences dialog | It is an `@shared/ui` `Modal` too, so opening it from inside a sheet makes it the blocking dialog | Nothing. It has no layer in the scale because it has nothing left to rank against |

## The alternatives

| Option | What it is | Why not |
|---|---|---|
| A `MODAL` entry in the scale | Give the sheet a number, and number anything that must clear it higher | The number is not what decides it. An entry here would read as a promise the scale cannot keep, and anything written to sit "above the modal" by out-numbering it would be wrong in a way no arithmetic in this file could catch |
| "Just make it big" — one very large `z-index` | What the previous toast library did, at 9999 | It satisfies every lower bound while breaking the one upper bound that matters. See below |
| Enter the top layer | What shipped | — |

## What decided it

### A number below the sheet is invisible, and a number above it is a lie

Both failures have already happened here, from opposite directions.

The Add-to-Calendar menu shipped at `z-90`, below the `z-100` the modal then
carried, and rendered behind the modal backdrop — invisible and unclickable, and
reported as "Add to Calendar doesn't work" (#203). Raising the number fixes the
*card* case and does nothing for the sheet case, because a `showModal()` dialog
is not in the numbered ordering at all. What actually fixes the sheet case is
`showPopover()`.

The toast failed the other way. `solid-toast` spread its own
`defaultContainerStyle` onto the container's inline `style`, carrying a hardcoded
`z-index: 9999`; inline style beats a Tailwind utility, so the layer class the
app passed was silently inert and the toast landed above the consent layers — the
one place it must never be. The only override that won was `containerStyle`.
`@shared/toast` sets no `z-index` at all, precisely so the layer is the
consumer's to state.

### The bound is two-sided, and asserted by measurement

`TOAST < CONSENT` is easy to lose to a large number satisfying every lower bound,
which is exactly what 9999 did. So the guard is two-sided and measured rather
than read: `cire/invites/tests/designs/InvitePage.browser.test.tsx` walks up from
the rendered toast to the fixed container and asserts its **computed** `z-index`
against both `Z_LAYER.STICKY_RAIL` and `Z_LAYER.CONSENT`. The relationship
between the constants, and the absence of a `MODAL` key, are pinned separately in
`cire/invites/tests/lib/z-index.test.ts`.

Read the bound as "below consent whenever both are in the document's stacking
order". While a sheet is open the toast is in the top layer, where a `z-index`
decides nothing — see [[toast]] §`topLayer`, for an app with `showModal()`
dialogs, which also covers what the top layer does *not* buy (paint, not reach:
everything outside the dialog is inert).

### The banner is above every numbered layer, and beneath a sheet

`CONSENT` (200) sits above every other numbered layer deliberately and with a
wide gap. It is the guest's route to granting — or later withdrawing — permission
for third-party content, and a consent control the guest cannot reach is worse
than no control at all, because the stored record would then assert a
freely-given choice they had no practical way to change.

*Every other numbered layer* is the exact claim, and the qualifier is the
important half: while a sheet is open the banner is painted beneath it and inert,
and comes back when the sheet closes. [[cire-consent]] §UI rules that are not
negotiable has the consequences for the consent surface itself.

### Why the scale is centralised at all

Every overlay pulls its layer from this one file rather than hardcoding a `z-<n>`
at the call site, so a new overlay cannot silently regress the order — #203 is
what that looks like when it is not. The numbers are also spelled out as literal
class strings (`Z_CLASS`) because Tailwind v4 generates `z-<integer>` utilities
only for literals its scanner can see: a computed `` `z-${TOAST}` `` emits no CSS
at all.

## What would make this worth revisiting

- A browser this site supports ships without the Popover API. The
  Add-to-Calendar menu feature-detects `showPopover` and falls back to the
  `z-index`, which loses the sheet case rather than the card case.
- Something has to appear over a sheet **and** be interactive. The top layer
  buys paint, not reach — that needs to be a descendant of the dialog, not a
  higher layer here.
- `@shared/ui`'s `Modal` stops being a `showModal()` dialog, which would put
  sheets back into the numbered ordering and make a `MODAL` layer meaningful
  again. See [[native-dialog-over-kobalte]] for what that would take.
