---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
"@cire/invites": patch
---

Tell a wedding's organisers when guests change their RSVPs.

- `@cire/db`: migration 0068 adds `rsvp_changes` (one row per guest-side RSVP change: household, guest, event, kind and time; an AUTOINCREMENT `seq` as the read cursor) and `host_rsvp_notices` (each organiser's read marker, digest marker and digest switch, per wedding).
- `@cire/api`: `POST /api/rsvp` logs each new or edited reply in the reply's own batch (dietary content is compared, never stored). `GET /rsvp-changes` and `POST /rsvp-changes/seen` serve every role that reads RSVPs; `PUT /rsvp-changes/digest` is the owner's and editors' own switch. The daily cron mails each wedding's owner and editors a count of the changes since their last digest (no guest names) and deletes change rows after 90 days. Removing a co-host deletes their notices row.
- `@cire/host`: an "RSVP changes since your last visit" card on the Overview with the daily-email switch, and "New" badges on changed rows in the RSVP table until the organiser opens it.
- `@cire/invites`: the privacy notice names the record of when a household's replies changed and its 90-day window.
- `@cire/api`: `POST /api/rsvp` gets the same per-IP limiter as the other guest writes (20 a minute).
