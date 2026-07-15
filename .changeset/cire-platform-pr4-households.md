---
"@cire/api": patch
"@cire/db": patch
"@cire/organiser": patch
---

Cire platform Phase 0 PR 4: households ≠ claim codes. A household (a `families`
row) can now exist with NO claim code — a manually-created guest-list record that
holds guests and can be edited, but has no claimable invite until an organiser
"issues" one. This decouples a household's existence from its invite credential.

- `@cire/db`: `families.public_id` made NULLABLE, and the column-level UNIQUE
  swapped for a PARTIAL unique index `families_public_id_uniq … WHERE public_id
  IS NOT NULL` (codes stay globally unique; many code-less households coexist
  because NULL is exempt). SQLite can't ALTER a column that way, so forward-only
  migration `0032_households_nullable_code.sql` does a full `families` REBUILD via
  the `__keep_*` snapshot/restore idiom: the whole cascade subtree (guests,
  sessions, guest_events, rsvps, guest_account_links) is snapshotted before the
  `DROP TABLE` (which fires `ON DELETE CASCADE` under D1's enforced FKs) and
  restored after, with every `families.id` copied VERBATIM so no child is
  orphaned. All three DDL surfaces mirrored (schema.ts / migration / setup.ts).
- `@cire/api`: `POST /api/organiser/weddings/:weddingId/households` creates a
  code-less household (`weddingEditor()` — a code-less household is guest-list
  data, a module write). `POST …/families/:familyId/issue-invite` (single) and
  `POST …/issue-invites` (bulk, one atomic batch) mint a `SURNAME-WORD-HASH` code
  onto code-less households — `weddingOwner()`-gated (code management), reusing
  the existing `generateFamilyCode`. Import KEEPS auto-minting a code per family
  (unchanged). Deactivation stays invite-only: the deactivate service now also
  refuses code-less households (nothing to cut off). The guest claim path
  naturally excludes NULLs, so a code-less household is never claimable until an
  invite is issued.
- `@cire/organiser`: the Guests table groups households by id (not code, so NULL
  codes don't collapse), shows "No code yet" for a code-less household plus a
  per-row "Issue invite" (owner) and a bulk "Issue N codes" header action.
