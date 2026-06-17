---
"@cire/web": minor
---

Turn the per-event "More Details" modal into a holistic event view.

The details modal is now a single, cohesive "everything about this event"
sheet: a timezone-aware date + time range, a branded map preview of the venue
with an "Open in Maps" action, the Add-to-Calendar control (moved here from the
outer event card), the description, the dress code with its colour palette, and
the Pinterest inspiration board. Each section collapses gracefully when its
data is absent.

The map preview is drawn entirely in CSS — a stylised cartographic card in the
invite palette — so it needs no map API key, no stored coordinates, and never
makes a network request. The "Open in Maps" link uses the organiser's `mapsUrl`
when present and otherwise derives a Google Maps search URL from the venue
address; if there is nothing to point at, the preview hides itself rather than
rendering a dead link.

The outer event card's button is relabelled "View Event" now that Add-to-
Calendar lives inside the details view.

The shared `AnimatedModal` (which hosts both this details view and the RSVP
modal) is hardened for accessibility: focus is moved into the panel on open and
restored to the trigger on close, Tab/Shift+Tab are trapped within the panel,
Escape closes the dialog, the dialog now carries an accessible name via
`aria-labelledby` (wired to each consumer's title), background scroll is locked
with `overscroll-behavior: contain` on the panel, the open/close animation
honours `prefers-reduced-motion` by snapping to the final visible state, and the
close button gets a 44×44px hit area with a visible focus ring.
