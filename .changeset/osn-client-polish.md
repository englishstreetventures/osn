---
"@osn/client": patch
---

Widens `authPost`/`authPatch`/`authDelete`/`authDeleteVoid` to accept an optional `AuthFetchOptions` with an abort signal, matching `authGet`. Also marks the package `sideEffects: false` so bundlers can tree-shake it, and moves the duplicated pagination query builder into `auth-fetch.ts`.
