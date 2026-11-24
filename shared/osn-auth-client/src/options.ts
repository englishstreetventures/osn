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
   * Expected `iss` claim — the OSN issuer URL (`AuthConfig.issuerUrl`). Set it:
   * when it is unset, `extractClaims` does not check `iss` at all. Every
   * service that verifies access tokens sets it. A mismatch is a terminal
   * failure (no JWKS refetch).
   */
  issuer?: string;
  /** Optional injected verifying key for tests (skips JWKS fetch). */
  _testKey?: CryptoKey;
}
