---
"@cire/invites": patch
"@cire/ui": patch
"@tools/e2e": patch
---

The event sheet gains a frosted bar that stays put while the panel scrolls under it, keeps its "Give RSVP →" / "← See details" badge, and the guest site's footer prints its build's version.

- `@cire/invites`: the top of the event sheet is a bar holding the event's name, the badge to the other panel and the close button. It stays at the top of the sheet while the details or the form scroll underneath it, frosted so the content shows through as it passes. The event's name is always shown whole: a long one wraps between its words onto more lines, a size smaller on a phone narrower than 380px, and the bar grows to hold it, and a control reached by Shift+Tab is never left hidden under the bar, however tall it gets.
- `@cire/invites`: the badge reads "Give RSVP →" on the details ("View your RSVP →" past the deadline for a household that has replied) and "← See details" on the form, as before the two-segment switch, which is gone. During a swipe its words move through it with the finger like a ticker, the old ones leaving by one side as the new come in from the other, rather than changing once the panels land, and it keeps one width throughout.
- `@cire/invites`: the panels lose their own "Details" and "Respond" headings; each panel now starts with its first content. Screen readers still hear "Details, Mehndi" or "Respond, Mehndi" as the sheet's name, and on every switch.
- `@cire/invites`: a swipe draws the arriving panel where it will rest, under the bar, at its full height, so the RSVP form's Save bar no longer lands past the sheet's bottom edge.
- `@cire/invites`: while the sheet is open, a drag that reaches the end of its scroll no longer rubber-bands or scrolls the invite behind it, and iOS no longer flashes grey over the sheet on a tap.
- `@cire/invites`: the footer prints "Version" and the first seven characters of the commit the site was built from, on its own line under Privacy Notice, Terms and Privacy Choices, or "Version local" for a build with none.
- `@cire/ui`: `Button`'s `chip` variant is back, for a control in a sheet's own chrome: a pill on the surface fill in accent ink.
- `@tools/e2e`: the `cire-rsvp` flow starts its swipes on the panels' content, drags on the sheet's bar, checks that a sideways flick on the bar's title leaves the details on screen, that the bar stays put while the details scroll 200px under it, that the badge shows part of each of its words side by side under a held swipe, and that the footer reads "Version local", with screenshots of the scrolled bar, the mid-swipe and the footer at 390 and 320px. `cire-rsvp-partial-after-deadline` opens the reply through "View your RSVP".
