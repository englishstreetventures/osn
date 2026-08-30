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

/**
 * The `iss` these tokens carry unless a caller says otherwise.
 *
 * Matches osn-api's own local default (`osn/api/src/build-deps.ts`) and the
 * default every downstream verifier falls back to, so a suite that injects a
 * test key and leaves the verification config alone mints tokens its routes
 * accept. Deployed tiers set both sides from `OSN_ISSUER_URL`.
 */
export const LOCAL_TEST_ISSUER = "http://localhost:4000";

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
  /**
   * Override the `iss` claim. Defaults to `LOCAL_TEST_ISSUER`, because every
   * downstream verifier now pins the issuer and a token minted without one is
   * rejected — which is the whole point. Pass a different origin to exercise
   * that rejection; pass `null` for a token carrying no `iss` at all, the
   * shape that existed before osn-api stamped it.
   */
  issuer?: string | null;
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
      const payload: Record<string, string> = {};
      payload.sub = profileId;
      if (claims.email !== undefined) payload.email = claims.email;

      let jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: claims.kid ?? "test-kid" })
        .setAudience(claims.audience ?? "osn-access")
        .setIssuedAt()
        .setExpirationTime(claims.expiresIn ?? "5m");

      const issuer = claims.issuer === undefined ? LOCAL_TEST_ISSUER : claims.issuer;
      if (issuer !== null) jwt = jwt.setIssuer(issuer);

      return jwt.sign(privateKey);
    },
  };
}
