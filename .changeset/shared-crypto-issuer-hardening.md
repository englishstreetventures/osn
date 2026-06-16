---
"@shared/crypto": minor
"@shared/osn-auth-client": minor
"@shared/redis": patch
"@osn/api": patch
"@pulse/api": patch
---

Harden shared crypto / auth-client issuer handling (W7).

- `@shared/crypto` `verifyArcToken` gains an optional `expectedIssuer` argument
  (X1). When set, jose enforces the signed `iss`, cryptographically binding the
  token issuer to the `kid`→issuer DB mapping. The OSN ARC middleware now passes
  the peeked issuer so a token whose `iss` differs from its `kid`'s registered
  service is rejected at verification time. Backward compatible — omitting the
  argument leaves `iss` unenforced.
- ARC token cache key now includes the requested `ttl` and a canonicalised
  scope (X3), so a token requested with a shorter TTL never reuses a
  longer-lived cached entry and formatting-only scope differences collapse onto
  one entry. Scope is not sorted (differing scope order stays distinct, matching
  the signed claim).
- The ARC public-key cache TTL is now overridable via
  `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS` (default 300), bounding the cross-process
  key-revocation window (X4).
- `@shared/osn-auth-client` `extractClaims` / `osnAuth` adapters gain an optional
  `issuer` option and apply a 30s `clockTolerance` (X2). Issuer is optional and
  unset by default for rollout safety — when unset, `iss` is not enforced so
  pre-issuer-stamping access tokens still verify. An issuer mismatch is terminal
  (no JWKS refetch).
- `@shared/redis` in-memory client `eval` now asserts it is only ever handed the
  rate-limit Lua script (X5), so a future, semantically-different script cannot
  silently inherit fixed-window rate-limit behaviour.
