---
"@cire/vendor": patch
"@cire/landing": patch
---

The remaining raw buttons in `cire/vendor` and `cire/landing` are resolved or explained

`cire/landing`'s RSVP cancel becomes `<Button variant="quiet">`, an exact match
for the variant it was writing out.

`cire/vendor`'s six are all deliberate and now say so at the site. Two wear
`cardClass({ interactive: true })`, which is the form `Card` exports its classes
*for* — the whole rectangle is the control, and `<div role="button">` is a worse
answer than either element. Two are chrome that must contribute no border or
padding of its own: an avatar menu trigger and the wordmark, which is a way home
rather than an action. Two are a tab bar — an `aria-current="page"` set with a
travelling highlight, where button chrome would say "press me" on a control
whose job is to say "you are here".

The overlays in both apps are unchanged and stay hand-rolled, because
`@shared/ui`'s `Modal` has no animation story and every overlay it is meant to
replace animates. Tracked as englishstventures/osn#1056, which needs a decision before
those conversions can be right rather than merely done.
