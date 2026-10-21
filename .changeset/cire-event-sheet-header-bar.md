---
"@cire/invites": patch
"@tools/e2e": patch
---

The event sheet gains a frosted bar that stays put while the panel scrolls under it, and the guest site's footer prints its build's version.

- `@cire/invites`: the top of the event sheet is a bar holding the event's name, the Details / Respond switch and the close button. It stays at the top of the sheet while the details or the form scroll underneath it, frosted so the content shows through as it passes. On a narrow phone the name is cut short with an ellipsis before the switch or the close button give way.
- `@cire/invites`: the panels lose their own "Details" and "Respond" headings, which repeated the switch's words beside it; each panel now starts with its first content. Screen readers still hear "Details, Mehndi" or "Respond, Mehndi" as the sheet's name, and on every switch.
- `@cire/invites`: a swipe draws the arriving panel where it will rest, under the bar, at its full height, so the RSVP form's Save bar no longer lands past the sheet's bottom edge.
- `@cire/invites`: while the sheet is open, a drag that reaches the end of its scroll no longer rubber-bands or scrolls the invite behind it, and iOS no longer flashes grey over the sheet on a tap.
- `@cire/invites`: the footer prints "Version" and the first seven characters of the commit the site was built from, on its own line under Privacy Notice, Terms and Privacy Choices, or "Version local" for a build with none.
- `@tools/e2e`: the `cire-rsvp` flow starts its swipes on the panels' content, drags on the sheet's bar rather than its old chrome row, checks that the bar stays put while the details scroll 200px under it, and that the footer reads "Version local", with screenshots of the scrolled bar and of the footer at 390 and 320px.
