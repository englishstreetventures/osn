---
"@shared/crypto": patch
"@osn/api": patch
---

Harden ARC S2S auth: bind the public-key cache to `(issuer, kid)` and fix Origin-guard S2S drift.

The ARC public-key cache was keyed by `kid` alone, so a cache hit returned the
key for whatever `issuer` the caller passed — silently skipping the
`serviceId == issuer` DB binding that only runs on the miss path. The same
forged-`iss` token was therefore rejected on a cold cache but accepted on a warm
one. The cache is now keyed by `(issuer, kid)` so the binding holds on both
paths; `evictPublicKeyCacheEntry` scans the composite keys. `verifyArcToken` now
requires `exp`/`iat`/`iss`/`aud` via jose `requiredClaims` so a token minted
without `exp` can never be treated as non-expiring.

The Origin-guard's hardcoded S2S exemption list had drifted from the real
internal route prefixes (`/internal/*` was unlisted and `/organisation-internal`
matched no route), so in production every ARC POST to `/internal/*` was 403'd
before ARC verification ran. The guard now exempts on the `Authorization: ARC`
header (immune to route renames) with segment-boundary path matching as a
secondary signal.
