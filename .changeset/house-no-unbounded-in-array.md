---
"@tools/oxlint-house": patch
"@cire/api": patch
---

`@tools/oxlint-house`: new `no-unbounded-in-array` rule, on at `error`. It reports drizzle's `inArray` or `notInArray` when the list's length is not fixed by the source: each element is one bound parameter, D1 refuses a statement over 100, and `bun:sqlite` allows 999, so the overflow shows only in production. `jsonEachIn(list)`, a subquery, an array literal and same-file `as const` tuples pass; a list that an enforced cap keeps under 100 is suppressed on its line with a reason that names the cap.

`@cire/api`: the organiser's premium-template read, a household's events on the invite, the carried-code check on an import preview, the vendor inbox's org filter and the before-image prune bind their id lists as one JSON parameter.
