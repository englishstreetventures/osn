---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
"@cire/web": minor
---

RSVP deadline for cire invites: an organiser sets a "kindly respond by" date and
the invite locks after it. Guests see the date on their invite and can reply — and
change their reply — up to the end of that day; past it the guest RSVP write is
refused and the invite renders read-only. A wedding with no deadline set behaves
exactly as before, which is what every existing wedding reads as.

- `@cire/db`: migration `0055_rsvp_deadline.sql` adds `weddings.rsvp_deadline`
  (date-only ISO `YYYY-MM-DD`, inclusive of its whole day) and
  `weddings.rsvp_deadline_timezone` (the IANA zone that day is measured in;
  `NULL` ⇒ UTC). Both nullable, so every pre-0055 row means "no deadline". They
  live on `weddings` rather than `wedding_invite_customisations` because that
  table is strictly presentational and this pair gates a write; the wall-time +
  zone pairing mirrors `events.start_at`/`timezone`.
- `@cire/api`: `lib/rsvp-deadline.ts` is the single place a date becomes an
  instant — the last millisecond of the day in its stored zone, via a two-pass
  `Intl` offset so a DST-transition day resolves on the offset the day *ends* on.
  It fails OPEN on a malformed date (no deadline) or an unresolvable zone (UTC),
  since a data problem must never lock guests out. `POST /api/rsvp` returns
  403 `{"error":"rsvp_closed"}` once the deadline has passed, reading the columns
  in the join it already makes for the family's kind (no extra round-trip), and
  counts refusals on `cire.rsvp.blocked{reason}`. The organiser-recorded RSVP
  endpoint is deliberately NOT gated — a phone or paper reply arriving after the
  date is exactly the case the deadline creates. The claim payload gains
  `rsvpDeadline: {date, timezone, closesAt, closed} | null`, and the Settings
  body accepts `rsvpDeadline` + `rsvpDeadlineTimezone` (zone validated against
  the runtime's own ICU data; clearing the date clears the zone in the same write,
  so a zone can never outlive its date).
- `@cire/web`: one verdict drives three surfaces in both design packs — a line
  under the events heading ("Kindly respond by …" / "RSVPs closed on …"), each
  card's Respond button (disabled and relabelled "RSVPs closed"; Event Details
  stays reachable), and the RSVP sheet (read-only, no submit button, dismiss says
  "Close"). Dates render in the wedding's zone, not the reader's. A single timer
  scheduled at `closesAt` — nothing polls — locks an invite left open across the
  deadline instead of letting it lead to a server 403, and an `rsvp_closed` 403
  gets its own copy, distinct from the authorisation 403.
- `@cire/organiser`: an "RSVP by" date picker in wedding Settings (owner-only,
  like the rest of that panel), which stamps the organiser's own time zone when
  the date is picked or changed and names that zone in its hint.
