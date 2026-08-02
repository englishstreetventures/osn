import { SignJWT } from "jose";

import { generateArcKeyPair } from "./jwk";

/**
 * Test-only helpers for minting OSN user access tokens.
 *
 * Every downstream API (`@pulse/api`, `@zap/api`, `@cire/api`) verifies access
 * JWTs the same way — ES256, `aud: "osn-access"`, profile id in `sub` — so
 * every one of their route suites needs a key pair and a signer. That block was
 * copy-pasted into a dozen files, each with its own subtly different `makeToken`
 * (some accepting an email, some not, some setting `exp`, some not). This is the
 * one implementation.
 *
 * Not exported from the package root: it pulls in test-shaped helpers that
 * production code has no business reaching for. Import from
 * `@shared/crypto/testing`.
 */

/** Claims a caller can vary per token. Everything else is fixed by the verifier contract. */
export interface AccessTokenClaims {
  /** Optional `email` claim — some routes read it for profile bootstrapping. */
  email?: string;
  /** Override the audience to exercise audience-rejection paths. */
  audience?: string;
  /**
   * Override the expiry. Defaults to `"5m"`, matching what production's
   * `issueAccessToken` stamps — a test token must never be longer-lived than a
   * real one. Pass a negative offset (`"-120s"`, comfortably past the verifier's
   * ±30s `clockTolerance`) to exercise the expired-token reject path.
   */
  expiresIn?: string;
  /** Set an `iss` claim — cire pins the issuer, other verifiers ignore it. */
  issuer?: string;
  /** Override the `kid` header to exercise key-mismatch paths. */
  kid?: string;
}

export interface AccessTokenSigner {
  /** Private key the signer mints with — rarely needed directly. */
  privateKey: CryptoKey;
  /** Public verifying key — hand to the route factory / `osnTestKey` injection. */
  publicKey: CryptoKey;
  /** Mints an ES256 access token (`aud: "osn-access"`) for `profileId`. */
  sign(profileId: string, claims?: AccessTokenClaims): Promise<string>;
}

/**
 * Generates an ephemeral ES256 key pair and returns it alongside a signer.
 * Call once per suite in `beforeAll` — keygen is cheap (~0.06ms) but there is
 * no reason to re-key per test, and a stable key keeps JWKS caches warm.
 */
export async function makeAccessTokenSigner(): Promise<AccessTokenSigner> {
  const { privateKey, publicKey } = await generateArcKeyPair();

  return {
    privateKey,
    publicKey,
    async sign(profileId, claims = {}) {
      const payload: Record<string, string> = { sub: profileId };
      if (claims.email !== undefined) payload.email = claims.email;

      let jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: claims.kid ?? "test-kid" })
        .setAudience(claims.audience ?? "osn-access")
        .setIssuedAt()
        .setExpirationTime(claims.expiresIn ?? "5m");

      if (claims.issuer !== undefined) jwt = jwt.setIssuer(claims.issuer);

      return jwt.sign(privateKey);
    },
  };
}
