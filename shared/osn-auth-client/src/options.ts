/**
 * What a service's access-token middleware needs to verify a request: the
 * JWKS to fetch keys from and the claims to enforce. Each service builds its
 * own middleware on `extractClaims` and extends this with its own options.
 */
export interface OsnAuthOptions {
  /** Full JWKS URL — e.g. `https://osn-api.example.com/.well-known/jwks.json` */
  jwksUrl: string;
  /** Expected `aud` claim — typically `"osn-access"` */
  audience: string;
  /**
   * Optional expected `iss` claim — the OSN issuer URL (`AuthConfig.issuerUrl`).
   *
   * **Rollout-safety: optional and unset by default.** When unset, `iss` is NOT
   * enforced, so access tokens minted before issuer-stamping still verify. Set
   * this only once every live token is known to carry a matching `iss` claim.
   * A mismatch is a terminal failure (no JWKS refetch).
   */
  issuer?: string;
  /** Optional injected verifying key for tests (skips JWKS fetch). */
  _testKey?: CryptoKey;
}
