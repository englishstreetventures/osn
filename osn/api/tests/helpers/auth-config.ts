import { generateArcKeyPair, thumbprintKid } from "@shared/crypto";
import { exportJWK } from "jose";

import type { AuthConfig } from "../../src/services/auth";

const BASE_CONFIG = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
} as const;

/**
 * Generates an ephemeral ES256 key pair for use in tests.
 * Call once in `beforeAll` and pass the result to route/service factories.
 */
export async function makeTestAuthConfig(): Promise<AuthConfig> {
  const { privateKey, publicKey } = await generateArcKeyPair();
  const kid = await thumbprintKid(publicKey);
  const jwtPublicKeyJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  return {
    ...BASE_CONFIG,
    jwtPrivateKey: privateKey,
    jwtPublicKey: publicKey,
    jwtKid: kid,
    jwtPublicKeyJwk,
  };
}
