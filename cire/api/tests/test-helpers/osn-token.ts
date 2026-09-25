import { makeAccessTokenSigner } from "@shared/crypto/testing";
import type { AccessTokenClaims } from "@shared/crypto/testing";

/**
 * The issuer these test tokens claim, matching `createApp`'s `osnIssuerUrl`
 * default and osn-api's own local default (`osn/api/src/build-deps.ts`).
 *
 * It has to be stated somewhere now that `iss` is enforced: a token minted
 * without one, or with another origin, is rejected — which is the point. A
 * suite testing that rejection signs with a different value and expects a 401.
 */
export const OSN_TEST_ISSUER = "http://localhost:4000";

export type OsnTestAuth = {
  /** Public verifying key — pass as `osnTestKey` to `createApp`. */
  key: CryptoKey;
  /**
   * Mints an ES256 access token (`aud: "osn-access"`) for `profileId`, valid
   * for five minutes and issued by `OSN_TEST_ISSUER`. `claims` overrides any
   * of that to reach a reject path: `{ expiresIn: "-120s" }` for an expired
   * token, `{ issuer }` for a foreign one, `{ audience }` for the wrong one.
   */
  sign(profileId: string, claims?: AccessTokenClaims): Promise<string>;
};

/**
 * Test-only stand-in for the OSN issuer: generates an ES256 key pair and
 * exposes the public key (for `osnTestKey` injection, skipping the JWKS
 * fetch) plus a signer that mints access tokens shaped like osn/api's —
 * including the `iss` claim, which every verifier now pins.
 *
 * Thin adapter over `@shared/crypto/testing`'s `makeAccessTokenSigner` — the
 * single implementation shared with the pulse and zap route suites. The
 * `{ key, sign }` shape is kept because the cire route suites destructure it.
 */
export async function makeOsnTestAuth(): Promise<OsnTestAuth> {
  const signer = await makeAccessTokenSigner();
  return {
    key: signer.publicKey,
    sign: (profileId, claims) =>
      signer.sign(profileId, { expiresIn: "5m", issuer: OSN_TEST_ISSUER, ...claims }),
  };
}
