---
"@cire/api": patch
"@cire/host": patch
---

The RSVP change log records plus-ones, and the organiser feed reads it in two
bounded parts.

- `@cire/api`: a household naming, renaming or removing its plus-one logs
  `plus_one_added`, `plus_one_renamed` or `plus_one_removed` in the batch that
  makes the change, keyed on the inviter, and only when the change happens.
  `GET …/rsvp-changes` now answers the card's summary only (no `rows`, no
  `markSeq`); the new `GET …/rsvp-changes/rows` answers the table's badges and
  a marker that covers exactly the rows it returns. Each read takes at most
  5,001 change rows.
- `@cire/host`: the Overview card reads the summary; the RSVP table reads the
  rows and posts back only their marker.
