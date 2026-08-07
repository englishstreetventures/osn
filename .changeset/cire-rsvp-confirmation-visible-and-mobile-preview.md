---
"@cire/web": patch
"@cire/organiser": patch
"@cire/api": patch
---

Let the recorded-RSVP confirmation actually be seen, and keep the invite
preview reachable on a phone.

**The confirmation played behind the sheet that was covering it.** #388 moved
the flourish onto the events section's Respond button precisely because that
control survives the sheet closing — but it cued the animation from
`setSaved`, the moment the reply is recorded, while the sheet still sits over
that button for its full `SAVED_DWELL_MS` dwell. The choreography runs
`TOTAL_DURATION_MS`, which is longer: the sweep-in, the tick draw and the
entire hold all elapsed under the open sheet, and the guest was uncovered onto
the closing fade alone — green draining off a button they never saw fill,
which reads as nothing having happened at all. `onConfirmed` now fires paired
with `onClose`, so the celebration starts on the frame the button becomes
visible and plays in full. A guest who dismisses the sheet early skips it and
keeps the permanent tick, which was always driven by the recorded data rather
than by this cue.

The seam slipped through because each side was tested alone: the invite-page
tests stub `RsvpModal` and invoke `onConfirmed` by hand, so nothing pinned it
against the dwell. `RsvpModal`'s own test now does, and a new
`rsvp-confirmation.integration.test.tsx` composes the real sheet with the real
card to assert the joint property neither side can state — *when the fill turns
on, the sheet is no longer over the button* — which also catches a subtler
re-arm: `RsvpModal` self-closes by calling `onClose()` directly rather than
through `AnimatedModal`'s awaited 200ms exit, and "polishing" that would put the
sweep back under a fading panel with every other test still green.

**The invite preview had no entry point on mobile.** The top bar wrapped
"Preview invite" in `hidden @2xl/frame:inline`, and the command palette
carries modules, weddings and account but no preview command — so below that
width the control did not exist anywhere in the portal. The button is now
mounted at every width and collapses to its glyph on a narrow bar, keeping its
label as `sr-only` (never `hidden`) so the accessible name survives the width
where only the glyph is drawn. A browser-tier test measures the painted result
at both widths, since a class string cannot tell whether Tailwind emitted any
CSS for it; `layout-utilities.test.ts` now also guards the `@container/frame`
declaration every `@2xl/frame:*` class in the portal depends on, which lived in
a single file no test rendered.

Also corrects two comments that described `/preview-code` as owner-gated when it
is `weddingMember`-gated — any wedding role, including a read-only `viewer`, may
mint a host preview code, which is what the route itself documents.
