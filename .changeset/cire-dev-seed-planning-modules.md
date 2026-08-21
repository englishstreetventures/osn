---
"@cire/db": patch
---

Seed the dev tier's planning modules, and let the dev seed hand the sample
wedding to a real account.

Budget, Checklist and Registry all shipped after the seed was written, so a dev
tier rendered every one of them empty — no budget lines, no payment schedule, no
checklist, no gift list and a guest registry that 404s because `published` was
never set. Nothing could be tested there without hand-typing rows that the next
`cire_api` deploy wiped.

- `@cire/db`: three new seed-data modules — `budget.ts` (14 lines across the
  service categories plus 10 payments, split between settled and outstanding;
  estimates land just under the wedding's budget total), `tasks.ts` (18 checklist
  tasks across all eight lead-time buckets, some already done) and `registry.ts`
  (a published settings row, 10 items and 3 claims covering
  purchased-and-thanked, purchased-not-thanked and still-reserved). Registry
  images stay NULL — an R2 key with no bytes renders broken — and item links
  point at `example.com` rather than live retailers.
- `scripts/cire-db-seed.sh`: apply `CIRE_DEV_OWNER_PROFILE_ID` on the dev target
  too, not just locally. The seed owns the wedding as `usr_dev_bootstrap_owner`,
  an id no account holds, so the dev tier's sample wedding — guests, events and
  the comped `registry`/`vendors` entitlements — was invisible to anyone signing
  in to test it.
- CI: the dev seed step passes `vars.CIRE_DEV_OWNER_PROFILE_ID` through. Set that
  variable on the `dev` environment; unset, the seed says so and carries on.
