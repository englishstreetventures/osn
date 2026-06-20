---
"@cire/web": patch
---

Round the mobile event-details bottom-sheet's top corners more so it reads as a
card that pops up.

The "more details" view is rendered by `AnimatedModal` as a bottom-anchored
sheet on mobile (`items-end`) and a centred dialog on desktop (`md:items-center`).
Its mobile top corners were `rounded-t-xl` (12px) — bumped to `rounded-t-[1.75rem]`
(28px) for a pronounced rounded top so the sheet reads as a card sliding up.
Mobile-first, so the larger top-rounding is scoped to small screens; the desktop
`md:rounded-lg` (all four corners) override is unchanged, keeping the centred
dialog look intact.

Maps embed note: investigated removing the Google Maps Embed iframe's built-in
"View larger map" / "Open in Google Maps" chrome (redundant with the app's own
"Open in Maps" button). The Maps Embed API `place` mode has no officially
documented parameter to suppress it, and hiding it with a CSS overlay would cover
Google's attribution and violate the Maps Platform ToS — so the embed is left as
is. The redundancy is cosmetic since the app already provides its own button.
