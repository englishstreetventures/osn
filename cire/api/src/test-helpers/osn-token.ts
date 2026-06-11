import { SignJWT, generateKeyPair } from "jose";

export type OsnTestAuth = {
  /** Public verifying key — pass as `osnTestKey` to `createApp`. */
  key: CryptoKey;
  /** Mints a 5-minute ES256 access token (`aud: "osn-access"`) for `profileId`. */
  sign(profileId: string): Promise<string>;
};

/**
 * Test-only stand-in for the OSN issuer: generates an ES256 key pair and
 * exposes the public key (for `osnTestKey` injection, skipping the JWKS
 * fetch) plus a signer that mints access tokens shaped like osn/api's.
 */
export async function makeOsnTestAuth(): Promise<OsnTestAuth> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return {
    key: publicKey,
    sign(profileId: string): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
        .setSubject(profileId)
        .setAudience("osn-access")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    },
  };
}
