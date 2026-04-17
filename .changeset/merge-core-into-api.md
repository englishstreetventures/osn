---
"@osn/api": minor
"@shared/crypto": minor
"@pulse/api": patch
---

Merge `@osn/core` into `@osn/api` and move `@osn/crypto` to `@shared/crypto`.

- `@osn/api` now owns all auth, graph, org, profile, and recommendations routes and services directly — no longer delegates to `@osn/core`
- `@shared/crypto` is the new home for ARC token crypto (was `@osn/crypto`); available to all workspace packages
- ARC audience claim updated from `"osn-core"` to `"osn-api"` for consistency with the merged service identity
- `@pulse/api` updated to import from `@shared/crypto` and target `aud: "osn-api"` on outbound ARC tokens
