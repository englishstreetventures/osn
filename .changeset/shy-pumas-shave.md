---
"@shared/crypto": patch
"@shared/osn-auth-client": patch
"@shared/dev-urls": patch
"@pulse/api": patch
"@zap/api": patch
---

Enforce the access-token `issuer` claim in every downstream verifier.

`@shared/osn-auth-client` has always accepted an expected `iss`, but every consumer left it unset — deliberately, because a verifier that pins the issuer rejects every token minted before osn-api started stamping one, and the rollout had to be verifier-first. Access tokens live five minutes, so that window closed long ago: every live token carries `iss`, and leaving the check off means a token from any other OSN deployment verifies here as long as it is signed by a key that deployment's JWKS vouches for.

`cire/api`, `pulse/api` and `zap/api` now pass the expected issuer on every `extractClaims` call. In pulse and zap the JWKS URL and the issuer travel as one `OsnTokenVerification` value rather than two loose strings, so a call site cannot supply one and silently forget the other — which is the failure mode that left this unenforced, since an unset expected issuer is not an error, it is simply no check.

`OSN_ISSUER_URL` is now required in a deployed tier and must equal osn-api's own value byte for byte; a mismatch 401s every authenticated request, so the two flip in the same deploy. `zap/api` gains the var, which it did not read before. `@shared/crypto/testing`'s signer stamps the local issuer by default, so a suite that injects a test key mints tokens its routes accept; pass a different origin, or `null`, to exercise the rejection paths.

Three things fell out of reviewing it. `extractClaims` now treats an expected issuer that is present but **empty** as a configuration failure rather than as "no issuer check" — an unset env var reaching the verifier was the one way this could look configured while checking nothing. The comparison normalises a trailing slash on both sides, since six hand-maintained `wrangler.toml` values feed it and `jose` compares byte for byte. And `zap/api` gains `OSN_ISSUER_URL`/`OSN_JWKS_URL` in the portless devloop, which it never had — every bearer-authenticated zap route was 401ing locally, and pinning the issuer is what made that visible.
