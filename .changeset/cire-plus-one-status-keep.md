---
"@cire/api": patch
"@cire/host": patch
"@cire/db": patch
---

An organiser's status change keeps a plus-one's household-given dietary answer.

- `@cire/api`: `PUT …/guests/:guestId/rsvps/:eventId` treats a body with
  neither `dietary` nor `dietaryPresets` as status-only. For a plus-one it sets
  the status and keeps the dietary answer, its consent record and
  `consent_source = 'inviter_attested'`, and answers with the stored row. A
  body naming either field still replaces the whole reply.
- `@cire/host`: the RSVP table records a plus-one's reply as `{ status }` and
  says the household's dietary requirements stay, instead of warning that
  saving clears them.
- `@cire/db`: the `consent_source` column comment names the one case where it
  states the dietary data's basis rather than who wrote the status.
