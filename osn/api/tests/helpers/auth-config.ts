import { generateArcKeyPair, thumbprintKid } from "@shared/crypto";
import { exportJWK } from "jose";

import { generateEphemeralTotpEncryptionKey } from "../../src/lib/totp-secret-crypto";
import type { AuthConfig } from "../../src/services/auth";

const BASE_CONFIG = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  // Any stable 32+ byte string works — the salt only has to be constant
  // within a test run for pairwise `sub` values to be reproducible.
  pairwiseSalt: "test-pairwise-salt-0123456789abcdef",
} as const;

/**
 * Generates an ephemeral ES256 key pair for use in tests.
 * Call once in `beforeAll` and pass the result to route/service factories.
 */
export async function makeTestAuthConfig(): Promise<AuthConfig> {
  const { privateKey, publicKey } = await generateArcKeyPair();
  const kid = await thumbprintKid(publicKey);
  const jwtPublicKeyJwk = await exportJWK(publicKey);
  return {
    ...BASE_CONFIG,
    jwtPrivateKey: privateKey,
    jwtPublicKey: publicKey,
    jwtKid: kid,
    jwtPublicKeyJwk,
    // A per-run key, like the signing pair above. Without one the TOTP service
    // fails closed, which is correct in production and useless in a test.
    totpEncryptionKey: await generateEphemeralTotpEncryptionKey(),
  };
}
