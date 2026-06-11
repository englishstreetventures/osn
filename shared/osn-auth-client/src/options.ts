/** Shared configuration for the per-framework `osnAuth` middleware adapters. */
export interface OsnAuthOptions {
  /** Full JWKS URL — e.g. `https://osn-api.example.com/.well-known/jwks.json` */
  jwksUrl: string;
  /** Expected `aud` claim — typically `"osn-access"` */
  audience: string;
  /** Optional injected verifying key for tests (skips JWKS fetch). */
  _testKey?: CryptoKey;
}
