---
"@cire/api": minor
"@cire/organiser": minor
---

Guest-roster and event-list CSV exports for the cire organiser dashboard —
companions to the existing RSVP export, so an organiser (or co-host) can
download each dashboard table.

- `@cire/api`: new `GET /api/organiser/weddings/:weddingId/guests.csv` and
  `…/events.csv` routes, gated by `weddingMember()` (owner OR co-host) with the
  same download contract as `rsvps.csv` (`Content-Disposition: attachment`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`). New
  `tableExportService` builds the CSVs: guests.csv is one row per guest (family
  code/name, guest name, invited event names in chronological order, invite
  Sent/Opened timestamps, Active/Deactivated code status; host families
  excluded, sorted by family code); events.csv is one row per event
  (chronological) with the dashboard's details, the dress-code palette as
  `Name (color)` pairs, http(s)-guarded URLs, and an invited-guest count. The
  CSV serialiser + formula-injection guard moved from `rsvp-export.ts` into a
  shared `lib/csv.ts`, and the event start-time comparator into
  `lib/event-order.ts` (both reused by the RSVP export).
- `@cire/organiser`: a "Download guests (CSV)" button beside the existing RSVPs
  export on the Guests tab, and a "Download events (CSV)" button on the Events
  tab (EventTable now receives the wedding slug for the filename). Both stream
  the server-built CSV through the shared blob-download helper with the usual
  auth-expiry redirect + success/error toasts.
