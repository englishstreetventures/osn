---
"@tools/pr-metrics": patch
---

Give `backfill.ts` its first tests, and make it name cards with `branchSlug`
rather than a partial copy of it — a branch name ending in a character outside
the slug's class made `backfill` and `card` write two different files for the
same branch.
