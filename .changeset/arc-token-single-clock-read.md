---
"@shared/crypto": patch
"@osn/api": patch
---

Derive a signed token's `exp` from the same clock read as its `iat`.

Both ARC tokens (`signArcToken`) and OSN access/step-up tokens (`signToken`)
called `setIssuedAt()` — which takes its own `Date.now()` — and then computed
the expiry from a second, later read. A token minted across a second boundary
therefore carried `exp - iat = ttl + 1`, a lifetime nobody configured, and made
`@shared/crypto`'s TTL assertion fail intermittently in CI.
