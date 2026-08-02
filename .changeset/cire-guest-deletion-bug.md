---
"@cire/api": patch
"@cire/organiser": patch
---

Fix guest deletion in the organiser's guest editor: deleted guests could come
back on reload.

The editor has no delete verb — it posts the whole draft as a DesiredState and a
deletion is the row's absence — so anything that keeps an existing row
reachable-but-unmatched, or lets a surviving desired row adopt it, is a delete
that applies successfully and silently does nothing.

- `@cire/api` (`diffAgainstDb`): the per-household collection the removal scan
  reads was keyed by normalised first name, so a household holding two guests
  whose first names collide (`Sam` and `sam `, two `Guest`s) kept only one of
  them in it — the other could never be deleted, and because the event-link pass
  keyed resolved ids the same way, both twins resolved to one id and one of them
  lost its event invitations on every save. The scan now reads the household's
  full guest list, name matching is a per-name queue each desired row consumes
  from (so a duplicate roster re-imports idempotently), and the link pass keys by
  parsed position.
- `@cire/api`: name matching is now a property of the front door (`matchByName`).
  A spreadsheet still matches id-less rows by name; the editor does not, because
  its draft carries an id for every row that exists — so deleting a guest and
  adding a different guest with the same first name in one save is a real remove
  plus create, instead of resolving the new row to the deleted one and handing it
  the deleted guest's RSVPs. The flag is persisted on the change row and re-read
  by the apply-time re-diff.
- `@cire/api`: an existing household/event is claimed by at most one desired row.
  Two desired households resolving to one existing row used to reconcile against
  its guest list twice, the second pass removing what the first had matched.
- `@cire/api`: a stale editor draft is refused rather than applied. `baseRevision`
  guards preview→apply, but the draft is built at load, and with name matching off
  a row whose id a co-host deleted in between would reconcile as a remove plus a
  create — dropping that row's RSVPs and returning a household under the claim
  code the draft still carried. An id that resolves to nothing now fails the diff
  and both verbs answer 409 `stale_draft`. A spreadsheet is unaffected: a dangling
  id there means the sheet carries no ids, and name matching is the design.
- `@cire/api`: a carried claim code that is already taken is replaced with a
  freshly minted one (with a preview warning) instead of failing the INSERT
  mid-apply — `applyImport` commits in chunks and stamps the before-image last, so
  that failure left a half-written wedding with nothing to revert to.
- `@cire/api`: new `GET /api/organiser/weddings/:weddingId/households`
  (`weddingMember()`) — the household-shaped roster read. `/guests` is
  guest-shaped, so a household holding no guests produces no rows there. It counts
  guests in SQL rather than returning one row per guest, and both roster reads are
  now `Cache-Control: no-store` (they carry claim codes) and log their failures.
- `@cire/organiser`: the guest + schedule editors load that read, so a household
  with no guests (added but not yet filled, or emptied by an earlier save) is
  carried in the draft as an empty card instead of being absent from it — absence
  meant the next save deleted the household and its live claim code, having never
  shown it.
- `@cire/organiser`: "Discard changes" restores the state the editor loaded
  rather than the oldest surviving undo snapshot; past the 100-entry undo cap
  (every keystroke checkpoints) that snapshot is a mid-edit state, so discarding
  kept edits while reporting the draft clean.
- `@cire/organiser`: both editors register the unsaved-changes guard while
  mounted and a `beforeunload` listener while dirty, so switching module/tab no
  longer throws an unsaved draft away without asking. An apply error now also
  renders inside the preview modal (the sticky bar it used to render in sits
  behind the modal overlay), and a 409 dismisses the stale preview.
- `@cire/organiser`: every roster cache carries a per-wedding generation that an
  invalidation bumps, so a fetch already in flight discards its rows instead of
  caching them — dropping the cache entry alone left the fetch's own callback free
  to write pre-mutation rows into a fresh entry, which is the deleted row coming
  back. The import-apply and revert paths invalidate households alongside events
  and guests; the three are one consistency unit.
