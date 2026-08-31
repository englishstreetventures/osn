---
"@cire/api": patch
---

Cut D1 round trips on cire's entitlement paths (osn-tracker#116, #117, #119, #120).

- **Gated organiser routes** (`vendor-directory.ts`, `vendors.ts`, `registry.ts`):
  `weddingMember(db, key)` / `weddingEditor(db, key)` now fold the entitlement
  presence check into their own `authorize()` query (an `EXISTS` column, same
  idiom as `directory.ts`'s `inWedding`) instead of `weddingEntitlement`
  running a separate one after — a co-host drops from 3 selects to 2, an owner
  from 2 to 1. Every route that mounts a role gate WITHOUT an entitlement gate
  is unaffected: the key is optional and only the three gated route files pass
  one.
- **CSV/editor import** (`services/import.ts`): `diffAgainstDb`'s capacity
  preview warning skips its entitlement query entirely once
  `existingGuests + guestCreates` can't possibly clear the 100-guest floor, and
  when it does run, `applyImport` reuses the derived cap (threaded through
  `ImportPlan.derivedCap`) instead of re-deriving it from a second query in the
  same request. Absent a cap on the plan, `applyImport` still enforces via its
  own query — never a way to skip the check.
- **Capacity queries narrowed**: `assertGuestCapacity` and the preview warning
  above now read `WHERE entitlement IN ('capacity_500', 'capacity_1000')`
  instead of every entitlement row on the wedding. `setsForWeddings` (feature
  display + `organiser-weddings.ts`'s cap derivation) is untouched.

No route contract changes; query-count claims proven by new tests
(`wedding-entitlement-fold.test.ts`, `import-capacity-query-count.test.ts`)
that count `db.select()` calls via a new `countingDb` test helper.
