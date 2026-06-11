---
"@pulse/db": minor
"@pulse/api": minor
"@pulse/app": minor
---

Add a venue detail page (initially scoped to clubs) plus a clickable
venue layer on the Explore map. Venues are namespaced under OSN
organisations so the same handle (and name) can recur across orgs.

- DB: new `venues` and `event_lineup` tables and a nullable
  `events.venue_id` FK. `venues` rows carry `org_handle` + `handle`
  with a unique `(org_handle, handle)` index; `id` is opaque (`ven_*`)
  and not URL-addressable.
- API: routes nest under `/venues/:orgHandle/:venueHandle` —
  `GET /venues` (index, feeds the map; tracked for bbox-aware
  replacement), `GET /venues/:orgHandle/:venueHandle`, `/events`, and
  `/events/:eventId/lineup`. Effect services with `pulse.venue.*`
  spans and bounded-cardinality metrics for the detail, events list,
  and lineup surfaces.
- Frontend page at `/venues/:orgHandle/:venueHandle` with a vertical
  mono-time lineup timeline, a snap-scroll event carousel, a real-time
  open/closed badge (computed in the venue's timezone, handles slots
  crossing midnight), an "Open in Maps" button, and icon links to
  website + Instagram. Discovery routes linking *into* the page are
  intentionally deferred — the Explore map is the first such surface.
- Explore map: new venue pin layer wrapped in `<A>` to the venue page.
  When a visible event pin sits at the same venue, the diamond is
  hidden and the event-pin popover gains a "See venue →" CTA. Popover
  is now pointer-event aware with a hover-grace timer so the button is
  reachable. `Icon` component promoted from `explore/` to `components/`
  with `globe` + `instagram` glyphs added.
