import { mintArcKid, type ArcKidSecrets } from "@shared/crypto/arc-kid";
import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { clearJwksCache } from "@shared/osn-auth-client/jwks-cache";

import { OSN_TEST_ISSUER } from "./osn-token";

/**
 * The osn-api origin these tests pin as cire's `osnIssuerUrl`: the issuer the
 * organiser test tokens carry too, so one app accepts both.
 */
export const OSN_ISSUER = OSN_TEST_ISSUER;

/** `OSN_ARC_KID_SECRET`'s stand-in: cire-api's `osnArcKidSecret`, when a test gives it one. */
export const KID_SECRET = "kid-secret-kid-secret-kid-secret-kid";

/** What osn-api holds for the kid MAC, as it mints a key's kid. */
export const OSN_HOLDS = {
  "the service secret": {
    kidSecret: undefined,
    serviceSecret: "test-internal-secret-of-32-chars!",
  },
  "both secrets": { kidSecret: KID_SECRET, serviceSecret: "test-internal-secret-of-32-chars!" },
} as const satisfies Record<string, ArcKidSecrets>;

/**
 * An osn-api stand-in for ARC, as cire-api sees it: one published key at
 * `<issuer>/.well-known/arc-jwks.json` (every other fetch goes through, and
 * each fetch of the set is counted) and tokens signed with it, its kid minted
 * as osn-api mints it holding `osnHolds`, both secrets unless told otherwise,
 * under `issuer` ({@link OSN_ISSUER} unless told otherwise). `restore` puts
 * `fetch` and the key cache back. Read by
 * `tests/routes/internal-account-deletion.test.ts`,
 * `tests/routes/internal-account-export.test.ts` and `tests/index.test.ts`.
 */
export async function osnArc(
  osnHolds: ArcKidSecrets = OSN_HOLDS["both secrets"],
  issuer: string = OSN_ISSUER,
) {
  const pair = await generateArcKeyPair();
  const kid = await mintArcKid(osnHolds, Math.floor(Date.now() / 1000) + 3600);
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
    if (String(input) !== `${issuer}/.well-known/arc-jwks.json`) return original(input, init);
    fetches += 1;
    return Response.json({ keys });
  }) as typeof fetch;
  clearJwksCache();
  return {
    /**
     * `Authorization: ARC <token>` for `scope`, from osn-api to cire-api unless
     * told otherwise: `signWith` signs with another private key under the
     * published kid, and `ttl` sets the lifetime in seconds.
     */
    token: async (
      scope: string,
      claims: { iss?: string; aud?: string; kid?: string; signWith?: CryptoKey; ttl?: number } = {},
    ) =>
      `ARC ${await signArcToken(
        claims.signWith ?? pair.privateKey,
        {
          iss: claims.iss ?? "osn-api",
          aud: claims.aud ?? "cire-api",
          scope,
          kid: claims.kid ?? kid,
        },
        claims.ttl,
      )}`,
    /** The kid of the published key. */
    kid,
    /**
     * A token for `scope` signed with the published key under `otherKid`,
     * which the set then also lists: only a check of the kid itself can
     * refuse it.
     */
    tokenUnderKid: async (scope: string, otherKid: string) => {
      keys.push({ ...jwk, kid: otherKid });
      return `ARC ${await signArcToken(pair.privateKey, {
        iss: "osn-api",
        aud: "cire-api",
        scope,
        kid: otherKid,
      })}`;
    },
    /** How many times cire-api has fetched the key set. */
    fetches: () => fetches,
    restore: () => {
      globalThis.fetch = original;
      clearJwksCache();
    },
  };
}
