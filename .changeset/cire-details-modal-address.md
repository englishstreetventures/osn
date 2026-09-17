---
"@cire/invites": patch
---

The invite's event details modal: the venue address wraps instead of being cut
off, and the Open-in-Maps action becomes an icon.

The address carried `truncate` — `white-space: nowrap` plus `text-overflow:
ellipsis` — so it clipped at every width rather than only narrow ones, and a
guest could not read where the event was. It now wraps. `wrap-anywhere` gives a
single unbreakable token somewhere to break, so no address can push the row
wider than the card, and `line-clamp-3` bounds an address of unlimited length,
which is a real case because nothing between the organiser's input and the
render constrains it.

The footer's "Open in Maps" was the widest thing on that row and the reason the
address had nowhere to go: 140.7px of a 236px footer at a 320px viewport,
leaving the address 83.3px. The words move into an `sr-only` span and a glyph
takes their place in a 44px box, which meets WCAG 2.2's target size. The
accessible name does not change — the link still names the venue — and the words
are clipped rather than removed, so nothing an assistive technology reads is
lost. That returns the address column to 180px, where an ordinary address takes
two lines and a full one down to its country takes three.

The action stays in **both** branches. It is a real link under the Google Maps
iframe, because it follows `resolveMapsUrl` and so goes to the organiser's own
`mapsUrl` where they set one — not the place Google's in-frame "View larger map"
opens. In the CSS-card fallback it stays a non-interactive `<span>` inside the
card's own anchor: the visible sign that the card is clickable, never a second
tab stop for one destination.

`MapPreview.browser.test.tsx` measures all of this in a real Chromium at 320,
768 and 1440 — the fast tier can only see that the text is in the DOM, which
truncation never changed, and cannot tell an `sr-only` label from a hidden one.
