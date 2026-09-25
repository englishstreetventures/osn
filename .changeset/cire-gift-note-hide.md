---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

An owner or editor can now hide a guest's gift note from the couple's gift log,
and show it again. Migration 0062 adds `note_hidden_at` and
`note_hidden_by_osn_profile_id` to `registry_claims` and
`registry_contributions`. `POST /api/organiser/weddings/:weddingId/registry/gifts/:kind/:giftId/note-hidden`
takes `{ hidden }` (owner and editors) and answers `{ ok, note, noteHidden }`.
The gift log sends a hidden note as `note: null` with `noteHidden: true`, and
`gifts.csv` prints `Note hidden` in its Note cell. The words stay in the row, so
the guest's own view and a data-subject request still return them, and the
retention sweep deletes them with the gift as before. The portal shows "Hide
note" under a note and "Note hidden" with "Unhide" once hidden; a viewer sees
"Note hidden" and no control.
