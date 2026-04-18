---
"@zap/api": minor
---

feat(auth): Zap API verifies OSN access tokens via JWKS (Copenhagen Book H4)

Zap is the last service still verifying user access tokens with a shared
symmetric secret (`OSN_JWT_SECRET`). Switch it to the same ES256 + JWKS
verification path Pulse uses — fetch the issuer's JWKS endpoint on cache
miss, verify with `algorithms: ["ES256"]`, refresh once on failure to
handle key rotation.

**Breaking env change:** `OSN_JWT_SECRET` is gone. Set `OSN_JWKS_URL` to the
issuer's JWKS endpoint (e.g. `https://osn.example.com/.well-known/jwks.json`).
Must be HTTPS in non-local environments.

Also closes S-L1 (zap): `jwtVerify` now restricts algorithms, so a crafted
`alg: none` token can no longer bypass signature verification.

New metric: `zap.auth.jwks_cache.lookups` (counter, attrs `{ result: hit | miss | refresh }`).
