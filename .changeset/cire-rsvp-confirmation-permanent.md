---
"@cire/invites": patch
---

Cire guest site: make the RSVP confirmation mark permanent by construction, and fix the save toast.

`EventCard` now holds the Respond button's bloom fill and tick in one monotone
signal that no code path sets back to false, with a separate signal owning only
the tick's stroke animation — a self-cancelling animation can no longer decide
whether a permanent mark exists (which is how the tick came to unmount 900ms in
on any path with no recorded row, host preview most visibly). A new `covered`
prop, wired from the open sheet, holds the mark back until the sheet is off the
button, so the sweep stays watchable even though the reply is recorded a full
dwell earlier — and a guest who dismisses the sheet early now ends up with the
same fully-marked button as one who watches the animation.

The fill also takes both its `scale-x-0` and `scale-x-100` from `classList`, so
exactly one is ever present: layering them relied on Tailwind's emitted utility
order, which resolves conflicts by stylesheet position and could invert under a
version bump.

The sweep now marks the *crossing* into a complete response rather than every
save that happens to leave the party complete: `RsvpModal` compares the party's
completeness before and after the save (reusing `hasHouseholdResponded` against
the pre-save rows) and cues the celebration only when it changes. Editing an
already-complete reply gets the toast and nothing else — re-running the sweep
there would animate a transition into a state the button is already in. Every
successful save still raises a toast saying a response was captured, whether it
is partial, completing, or an edit.

The `<Toaster>` moves from inside the events section to the page root, on a new
`Z_LAYER.TOAST` above the modal layers. Inside the section it was unusable: the
section is gated on non-preview mode, so host preview had no toaster mounted at
all, and Motion One's reveal leaves an inline `transform` there that makes the
section a containing block and stacking context for the fixed toaster — so the
toast was positioned against the section rather than the viewport and painted
behind the RSVP sheet it fires underneath.

Adds a real-Chromium test tier for all of it (`EventCard.browser.test.tsx`,
`rsvp-confirmation.browser.test.tsx`, `classic/InvitePage.browser.test.tsx`),
measuring the painted fill seconds after every timer expires and asserting the
toast has no fixed-position containing block between it and the document body.
