---
"@shared/crypto": minor
"@shared/observability": patch
"@osn/api": minor
"@pulse/api": minor
---

Switch OSN access token signing from HS256 to ES256 and expose a JWKS endpoint.

- `@shared/crypto`: add `thumbprintKid(publicKey)` helper (RFC 7638 SHA-256 thumbprint)
- `@shared/observability`: add `JwksCacheResult` metric attribute type
- `@osn/api`: replace `AuthConfig.jwtSecret` with `jwtPrivateKey`, `jwtPublicKey`, `jwtKid`, `jwtPublicKeyJwk`; add `GET /.well-known/jwks.json`; update OIDC discovery with `jwks_uri`; ephemeral key pair in local dev when env vars are unset
- `@pulse/api`: replace symmetric JWT verification with JWKS-backed ES256 verification; add in-process JWKS key cache with 5-minute TTL and rotation-aware refresh; remove `OSN_JWT_SECRET` dependency
