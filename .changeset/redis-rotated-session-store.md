---
"@osn/api": patch
"@shared/observability": patch
---

Cluster-safe rotated-session store for C2 reuse detection (S-H1 session / P-W1 session). Extracted `RotatedSessionStore` interface with in-memory + Redis-backed impls in `osn/api/src/lib/rotated-session-store.ts`, wired from `osn/api/src/index.ts`. Shipping with `{action, result, backend}`-dimensioned counter + duration histogram (`osn.auth.session.rotated_store.*`) and `RotatedStoreAction`/`RotatedStoreResult`/`RotatedStoreBackend` attribute unions in `@shared/observability`. Fail-open on Redis error so an outage cannot manufacture false-positive family revocations.
