---
"@shared/osn-auth-client": patch
---

Bound the JWKS negative cache and throttle forced refetches (amplification DoS).

Two amplification vectors in the downstream token verifier:

- The negative cache had no size cap, so an unauthenticated flood of tokens with
  random `kid`s grew the map without bound (heap-exhaustion DoS). It is now
  FIFO-bounded to NEGATIVE_CACHE_MAX_SIZE.
- A valid-`kid`/bad-signature token forced an unconditional JWKS refetch, and
  because kids are public an attacker could drive one upstream fetch per
  request against the issuer's JWKS endpoint. Forced refetches are now throttled
  to at most once per kid per cooldown window; a genuine key rotation is still
  picked up by the first refetch in the window.
