---
"@osn/api": patch
---

`GET /graph/internal/profile-search` takes an optional `requesterId` and, when given one, leaves out every profile with a block against it, either way round, in the same statement, so the page still fills to its limit. Without it the results are as before.
