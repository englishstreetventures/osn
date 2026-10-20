---
"@cire/db": minor
"@cire/api": minor
"@cire/host": minor
"@cire/invites": minor
"@tools/e2e": patch
---

Organisers can give an event a description and a venue name, and guests see both

- **The organiser's event drawer** gains **Venue name** and **Description**
  fields. The events table shows both, and each is capped at 10,000
  characters, as the server caps it.
- **The events spreadsheet** gains a **Description** column. Its **Location**
  column is now the venue's name and fills the new `events.venue_name` column
  (migration `0086_event_venue_name.sql`). It no longer stands in for a blank
  Address, which stays blank. A sheet without a Location or Description column
  leaves what each event already has; a blank cell in one clears it. Both
  re-importable downloads carry the two columns, so do the restore points a
  revert reads, and the reporting `events.csv` gains a Venue column.
- **The guest invite** shows the venue's name above its address in the
  details sheet, puts it before the address in calendar entries (the `.ics`
  file and the Google Calendar link), and names the venue on the event card.
  The map searches for the address, or for the name when there is no address.
  About shows the organiser's description with its line breaks, and the card
  shows its first three lines.
- The claim response and the organiser's `GET /events` carry `venueName`. The
  guest site and the portal treat it as optional, so either can deploy before
  the API. The portal still sends `location: null` for an older API, which
  then drops the two new fields: deploy `cire-api` first.
- The bun dev server (`src/local.ts`) now builds the organiser sign-in client
  from `OSN_ISSUER_URL`, `CIRE_API_ORIGIN`, `CIRE_OIDC_CLIENT_ID` and
  `CIRE_OIDC_CLIENT_SECRET` when all four are set.
- The end-to-end suite boots the organiser portal and signs an organiser in
  through osn-api's dev sign-in and a first-party cire client. A new flow,
  `cire-event-details`, sets a venue name and a description in the drawer and
  checks them in the preview's sheet, its claim response and its `.ics` file.
