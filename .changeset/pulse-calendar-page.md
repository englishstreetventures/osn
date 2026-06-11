---
"@pulse/app": minor
"@pulse/api": minor
"@pulse/db": minor
---

Pulse calendar page: a vertical-timeline agenda (`/calendar`) listing the events you're hosting or have RSVP'd Going / Maybe to, grouped by day with a continuous timeline axis on the left. Maybe RSVPs surface an inline reminder to confirm (I'm going) or drop (Can't make it). Backed by a new auth-gated `GET /events/calendar` endpoint + `listMyCalendarEvents` service (instrumented with the `pulse.calendar.events.fetched` metric and a `pulse.calendar.list_mine` span). The Calendar tab in the Explore nav now routes here.

Also renames the RSVP "interested" status to "maybe" end-to-end (DB enum value, API wire value, metrics, and UI) — no legacy alias, as nothing is deployed yet. The per-event `allowInterested` toggle column keeps its name.
