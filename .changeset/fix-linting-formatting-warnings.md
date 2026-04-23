---
"@osn/api": patch
"@osn/client": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/api": patch
---

Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
