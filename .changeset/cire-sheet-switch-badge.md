---
"@cire/invites": patch
"@cire/ui": patch
"@tools/e2e": patch
---

Move between an event's details and its RSVP form with one matching badge, or a swipe.

- `@cire/invites`: the event sheet's way between its two panels moves into the sheet's chrome, beside the close button. It is a pill reading "Give RSVP →" on the details ("View your RSVP →" past the deadline for a household with a reply on file) and "← See details" on the form. It replaces the details' call-to-action button and the form's text link. On a touch screen the panel follows a sideways drag toward the other one: it carries on past three tenths of the width or after a flick, and springs back otherwise. Vertical scroll, a drag in a text field and a drag on the dietary chips stay theirs. A double tap on the badge neither goes straight back nor closes the sheet.
- `@cire/ui`: `Button` gains a `chip` variant, a control in a sheet's chrome.
- `@tools/e2e`: the `cire-rsvp` flow opens the ceremony's details on a phone and checks four things: that a vertical drag scrolls, that a slow short drag springs back, that swipes go to the form and back, and that the badge returns with the unsaved answer intact before it saves. It writes screenshots of both panels.
