---
"@osn/social": minor
"@osn/core": minor
"@osn/client": minor
"@osn/app": patch
---

Add `@osn/social` app — identity and social graph management UI. Add
`recommendations` service and route to `@osn/core`. Add `graph` and
`organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
`DropdownMenuGroup` (required by Kobalte).
