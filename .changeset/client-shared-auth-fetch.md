---
"@osn/client": patch
---

Factor the duplicated bearer-token fetch helpers out of `graph.ts`, `organisations.ts` and `recommendations.ts` into one shared `auth-fetch.ts` module. No behaviour change.
