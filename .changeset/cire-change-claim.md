---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
---

The organiser change pipeline lets one change write a wedding at a time, and
bounds what a change can carry.

- `@cire/db`: migration `0070_change_rev_and_claim.sql` adds `change_rev`,
  `change_claim` and `change_claimed_at` to `weddings`.
- `@cire/api`: the change head is the `change_rev` counter (a primary-key
  read); apply and revert take the wedding's change claim at the head they were
  prepared against before their first write, and 409 with
  `reason: "change_in_progress"` while another change holds it. Apply returns
  the head after its own commit. A guests-scoped revert reads the schedule once.
  Dress-code palette colours must pass the theme colour allow-list at both
  front doors and on read. A schedule holds at most 200 events and an editor
  draft at most 5,000 households.
- `@cire/host`: the editors seed their reloaded draft from the revision the
  apply returns, the guests editor names an in-progress refusal, and the import
  panel explains the new `too many events` error.
