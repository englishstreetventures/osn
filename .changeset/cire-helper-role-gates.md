---
"@cire/api": patch
"@cire/db": patch
---

Add the `helper` co-host role, and make the wedding authorisation gates
exhaustive over the role enum so a new role cannot fail open into them.

A `helper` is someone handed a job on the day of the wedding. They get the day-of
run sheet and nothing else — not the guest list, not the budget, not the
registry, not the vendors, not the RSVPs.

- `@cire/api`: the three role gates no longer decide for themselves which roles
  to turn away. `policyFor()` in the new `middleware/wedding-role.ts` is the
  single authorisation table, and its switch is exhaustive over `WeddingRole`
  with no `default`; `HostRole` derives from the Drizzle column
  (`Exclude<StoredHostRole, "host">`) rather than being written out beside it.
  Adding a value to `wedding_hosts.role` therefore fails the type check until
  every gate has been given a decision about it. Before this, `weddingMember()`
  excluded no role at all and `weddingEditor()` excluded `viewer` by name, so a
  new role would have inherited the whole read surface with nothing failing.
- `@cire/api`: new `weddingRunSheet()` gate for the routes a helper is meant to
  reach. Standalone and mounted instead of `weddingMember()`, never after it. It
  derives the caller's own seat id and their run-sheet scope, and
  `runSheetVisibleTo()` narrows a response body to what that scope allows. No
  route mounts it yet — the run-sheet view is a later change.
- `@cire/api`: an unrecognised stored role degrades to the lowest-ranked role in
  the enum, read off a rank map instead of naming one. The previous literal
  `viewer` would have outranked `helper` the moment `helper` landed, leaving a
  corrupted row with the whole read surface.
- `@cire/db`: `wedding_hosts.role` gains `helper`, and a new
  `wedding_hosts.run_sheet_scope` (`own | full`, default `own`) holds a helper's
  visibility. Migration `0059`; every seat that predates it back-fills to `own`.

Nothing can assign the role yet: `HostRoleSchema` stays `editor | viewer` and
`hostsService.add()` / `setRole()` take `AssignableHostRole`, so the compiler
refuses a route that tries.
