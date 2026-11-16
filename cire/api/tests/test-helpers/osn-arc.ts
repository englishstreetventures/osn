import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { clearJwksCache } from "@shared/osn-auth-client/jwks-cache";

import { OSN_TEST_ISSUER } from "./osn-token";

/**
 * The osn-api origin these tests pin as cire's `osnIssuerUrl`: the issuer the
 * organiser test tokens carry too, so one app accepts both.
 */
export const OSN_ISSUER = OSN_TEST_ISSUER;

/**
 * An osn-api stand-in for ARC, as cire-api sees it: one published key at
 * `<issuer>/.well-known/arc-jwks.json` (every other fetch goes through, and
 * each fetch of the set is counted) and tokens signed with it. cire-api holds
 * no kid secret, so the kid is a plain id. `restore` puts `fetch` and the key
 * cache back. Read by `tests/routes/internal-account-deletion.test.ts`.
 */
export async function osnArc() {
  const pair = await generateArcKeyPair();
  const kid = `${crypto.randomUUID()}.${Math.floor(Date.now() / 1000) + 3600}.test`;
  const jwk = {
    ...JSON.parse(await exportKeyToJwk(pair.publicKey)),
    kid,
    alg: "ES256",
    use: "sig",
  };
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== `${OSN_ISSUER}/.well-known/arc-jwks.json`) return original(input, init);
    fetches += 1;
    return Response.json({ keys: [jwk] });
  }) as typeof fetch;
  clearJwksCache();
  return {
    /** `Authorization: ARC <token>` for `scope`, from osn-api to cire-api unless told otherwise. */
    token: async (scope: string, claims: { iss?: string; aud?: string; kid?: string } = {}) =>
      `ARC ${await signArcToken(pair.privateKey, {
        iss: claims.iss ?? "osn-api",
        aud: claims.aud ?? "cire-api",
        scope,
        kid: claims.kid ?? kid,
      })}`,
    /** How many times cire-api has fetched the key set. */
    fetches: () => fetches,
    restore: () => {
      globalThis.fetch = original;
      clearJwksCache();
    },
  };
}
