---
"@cire/api": patch
"@cire/db": patch
"@cire/organiser": patch
---

Revert "households ≠ claim codes" (#254) — every household carries a claim code
again (product-owner decision, 2026-07-15). There is NO code-less household:
`families.public_id` is required and globally unique again. This undoes PR 4's
decoupling of a household's existence from its invite credential.

- `@cire/db`: `families.public_id` restored to `text NOT NULL` + a full
  column-level `UNIQUE` (the partial `families_public_id_uniq` index 0032 added is
  dropped). 0032 (`0032_households_nullable_code.sql`) is KEPT in history — it
  already ran on the production D1 and is tracked in `d1_migrations`, so removing
  it would desync a fresh D1 from prod. Instead, forward-only reversing migration
  `0033_households_require_code.sql` rebuilds `families` via the same `__keep_*`
  snapshot/restore idiom: the whole cascade subtree (guests, sessions,
  guest_events, rsvps, guest_account_links) is snapshotted before the `DROP TABLE`
  (which fires `ON DELETE CASCADE` under D1's enforced FKs) and restored after,
  with every `families.id` copied VERBATIM so no child is orphaned. 0033 FAILS
  LOUD if any code-less household (`public_id IS NULL`) still exists — the NOT
  NULL rebuild rejects a NULL row rather than coercing a placeholder, so a human
  must mint that household a real code first. All three DDL surfaces mirrored back
  (schema.ts / migration / setup.ts); T-S1 lockstep green for the 0001…0033 chain.
- `@cire/api`: deleted the code-less-household create (`POST …/households`) and
  "issue invite" (`POST …/families/:id/issue-invite`, `POST …/issue-invites`)
  routes + their `households`/`issue-invite` services and `household` schema, plus
  the `cire.household.created` / `cire.invite.issued` metrics. The deactivate
  service no longer special-cases code-less households (any guest family can be
  deactivated). Import STILL auto-mints a code per family (unchanged) and the
  guest claim path is unchanged.
- `@cire/organiser`: the Guests table is back to grouping households by
  `publicId` with no "No code yet" row, per-row "Issue invite" button, or bulk
  "Issue N codes" action; `OrganiserGuestRow.publicId` + the guests-store type are
  non-nullable again.

A human must confirm ZERO production `families` rows have a NULL `public_id`
before this merges (0033 will abort loudly on such a row).
