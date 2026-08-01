---
"@cire/api": minor
"@cire/organiser": minor
---

Cire host dashboard: upload the events CSV or the guests CSV on its own — both
sheets are no longer required on every import.

Previously the spreadsheet front door demanded `eventsCsv` AND `guestsCsv` on
every request, so an organiser who only moved a ceremony time had to re-export
and re-upload the whole guest list alongside it (and vice versa). Omitting a
sheet was not merely unsupported but dangerous by construction: the desired
state is the whole truth, so an empty guests sheet reconciles by deleting every
household.

- `@cire/api`: new `ChangeScope` (`both` | `events` | `guests`) threaded from
  the request body through the diff, the change row and revert.
  `CsvChangeBody` now takes each sheet as optional with a refinement requiring
  at least one (neither ⇒ the shared 400). `diffAgainstDb` gains
  `options.scope`, which SUPPRESSES ops for the unmanaged half rather than
  diffing it against an empty desired state — an events-only change emits no
  household/guest/link op at all, a guests-only change emits no event op, not
  even a no-op update that would bump `updated_at` and re-resolve every
  Pinterest link at apply time. A guests-only upload matches its attendance
  columns against the events that already exist, read once and mapped straight
  from DB rows, and re-read from LIVE state at apply so a concurrently-added
  event isn't a stale snapshot. `scope` is persisted on the change row's
  summary and decoded back at apply, so the TOCTOU re-diff manages exactly the
  halves the preview did; a row written before this change has no `scope` and
  defaults to `both`. `revert` treats a blank snapshot half as "not captured"
  instead of "empty", and only replays a `kind='import'` predecessor, so the
  legacy prior-import path can never turn a partial upload — or an editor
  save's JSON blob — into a mass delete. The preview response echoes `scope`.

  D1 read counts, precisely: an events-only preview saves four reads (three
  guest-table reads plus the now-conditional `weddings.codeStyle`); a
  guests-only upload is at parity with a two-sheet one. The events-only saving
  is preview-only — `captureBeforeImage` correctly re-reads the guest tables at
  apply, because an events-only change that removes an event cascades
  `guest_events` and `rsvps`, so that snapshot is load-bearing for revert.
- `@cire/organiser`: both file inputs are optional — Preview stays disabled
  until at least one sheet is chosen, and the panel posts only the keys it has
  (an omitted key, never `""`). A live hint names what each selection will and
  won't touch ("Guests only — your schedule won't be touched"), echoed back
  from the server's decoded scope on the diff preview. Each chosen sheet gets a
  Remove control that also drops any preview computed from it, so Apply can't
  commit a plan for a file that is no longer selected. The chosen-file chip
  moved out of the `<label>` — nested there it inherited the label's text as
  its accessible name and a click would have re-opened the file picker. Copy
  and the three-step format guide reworked around one-or-both.
