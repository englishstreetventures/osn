import { mintArcKid } from "@shared/crypto/arc-kid";
import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { clearJwksCache } from "@shared/osn-auth-client/jwks-cache";

import type { OsnTokenVerification } from "../../src/lib/jwks";

/** The osn-api origin these tests pin. */
export const OSN_ISSUER = "http://osn.test";

const SECRET = "test-internal-secret-of-32-chars!";

/**
 * An osn-api stand-in for ARC: one published key at
 * `<issuer>/.well-known/arc-jwks.json` (every other fetch goes through,
 * and each fetch of the set is counted), the kid MAC secret set as the app's
 * `INTERNAL_SERVICE_SECRET`, and tokens signed with that key. `restore` undoes
 * all three.
 */
export async function osnArc() {
  const pair = await generateArcKeyPair();
  const kid = await mintArcKid(SECRET, Math.floor(Date.now() / 1000) + 3600);
  const jwk = {
    ...JSON.parse(await exportKeyToJwk(pair.publicKey)),
    kid,
    alg: "ES256",
    use: "sig",
  };
  const keys = [jwk];
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== `${OSN_ISSUER}/.well-known/arc-jwks.json`) return original(input, init);
    fetches += 1;
    return Response.json({ keys });
  }) as typeof fetch;
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
  clearJwksCache();
  const verification: OsnTokenVerification = {
    jwksUrl: `${OSN_ISSUER}/.well-known/jwks.json`,
    issuer: OSN_ISSUER,
  };
  return {
    verification,
    /** `Authorization: ARC <token>` for `scope`, from osn-api to Pulse unless told otherwise. */
    token: async (scope: string, claims: { iss?: string; aud?: string } = {}) =>
      `ARC ${await signArcToken(pair.privateKey, {
        iss: claims.iss ?? "osn-api",
        aud: claims.aud ?? "pulse-api",
        scope,
        kid,
      })}`,
    /** The kid of the published key. */
    kid,
    /** How many times the app has fetched the key set. */
    fetches: () => fetches,
    /**
     * A token signed with the published key under `otherKid`, which the set
     * then also lists: only a check of the kid itself can refuse it.
     */
    tokenUnderKid: async (scope: string, otherKid: string) => {
      keys.push({ ...jwk, kid: otherKid });
      return `ARC ${await signArcToken(pair.privateKey, {
        iss: "osn-api",
        aud: "pulse-api",
        scope,
        kid: otherKid,
      })}`;
    },
    restore: () => {
      globalThis.fetch = original;
      delete process.env.INTERNAL_SERVICE_SECRET;
      clearJwksCache();
    },
  };
}
