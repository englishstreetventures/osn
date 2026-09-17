---
"@cire/ui": patch
"@cire/invites": patch
"@cire/landing": patch
---

The guest site's call to action becomes a `@cire/ui` variant

`Button` gains a `cta` variant and an `lg` size, and eight raw `<button>`
elements across `cire/invites` and `cire/landing` become it — the claim-code
submit on both invite designs, the gift-registry reserve and payment actions,
the consent banner's accept, and the marketing demo's three.

`cta` is outline at rest and primary on hover, which is not a second `outline`.
An invite is restrained enough that a solid gold fill at rest would be the
loudest thing on a page whose job is a photograph and a date, so its primary
action is drawn as an outline and promotes on hover. A dashboard has the
opposite problem, so in the portals `primary` is filled from the start. Both
products need both.

`Button` also gains a focus ring of its own, from `--ui-focus`. A library
component cannot assume its host declares a blanket `:focus-visible` rule: the
two portals and `cire/invites` do, `cire/landing` does not, and each converted
call site had written one out by hand. The values match what the portals' global
rule already draws, so nothing moves there.

One button deliberately stays raw, with the reason in the code. `RsvpModal`'s
submit marks its *confirmed* state with `aria-disabled` — a control that has
already done its job — and `Button` fades anything carrying that attribute, on
the reading that it marks a control someone cannot press and should be told why.
The one state that must look most alive is exactly the one the shared variant
would grey out.

A browser test in `cire/invites` now checks the whole four-link chain as a
painted colour rather than a string: the component's `base:bg-ui-accent`, the
contract's alias, this app's mapping, and the gold itself — three of which live
in files the component never mentions. It also asserts that overriding
`--color-gold` on `<html>` repaints the button, which is the runtime-palette
join every wedding's invite depends on.
