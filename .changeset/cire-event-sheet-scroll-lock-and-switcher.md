---
"@cire/invites": patch
"@cire/ui": patch
"@tools/e2e": patch
---

The event sheet keeps the page still behind it, and moves between its panels with a switch that follows the finger.

- `@cire/invites`: the event sheet now locks the page behind it on the root element, so a wheel or a touch on the sheet's chrome or backdrop no longer scrolls the invite underneath. A page showing a classic scrollbar keeps its width while the sheet is open, and a page showing none (a short invite, a phone) is left as wide as it was.
- `@cire/invites`: after a swipe or a tap between the details and the RSVP form, the arriving panel's heading no longer shows a focus ring that reads as "selected"; a key press still shows it. A drag no longer carries a text selection across the sheet.
- `@cire/invites`: the badge beside the close button is now a two-segment switch, Details and Respond ("Your RSVP" past the deadline), with the panel on screen filled gold. Its gold pill slides with a swipe and the words change ink as it crosses them, instead of the label flashing to new text once the panels land.
- `@cire/invites`: tapping "Add to calendar" no longer opens the menu with Google Calendar already filled gold, as if chosen. A tap or click opens it on the menu itself; an item fills gold under the pointer, while a finger presses it, or when the keyboard reaches it, and opening the menu by keyboard still lands on the first item.
- `@cire/invites`: "Open in maps" offers Google Maps, Apple Maps and Waze. An organiser's own maps link takes the place of the app it belongs to (for Google Maps, a link from `google.com` or one of a fixed list of Google's country domains, or a `goo.gl` or `g.page` share link), or comes first as "Venue map" when it is from another site; when it is the only place to go, the row keeps its plain link.
- `@cire/ui`: `Button` loses its `chip` variant, which nothing uses any more.
- `@tools/e2e`: the `cire-rsvp` flow names the switch's segments, checks that the page behind the sheet had room to scroll, that a drag on the sheet's chrome or backdrop leaves it where it was, and that the switch stands part-way under a held swipe, and writes a mid-swipe screenshot. `cire-rsvp-partial-after-deadline` opens the reply from the "Your RSVP" segment.
