import { mintArcKid, readArcKeyAsk, type ArcKidSecrets } from "@shared/crypto/arc-kid";
import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { clearJwksCache } from "@shared/osn-auth-client/jwks-cache";

import type { OsnTokenVerification } from "../../src/lib/jwks";

/** The osn-api origin these tests pin. */
export const OSN_ISSUER = "http://osn.test";

/** `INTERNAL_SERVICE_SECRET`'s stand-in, long enough to key the kid MAC. */
export const SERVICE_SECRET = "test-internal-secret-of-32-chars!";
/** `OSN_ARC_KID_SECRET`'s stand-in. */
export const KID_SECRET = "kid-secret-kid-secret-kid-secret-kid";

/** What osn-api or the app can hold for the kid MAC. */
export const HOLDS = {
  nothing: { kidSecret: undefined, serviceSecret: undefined },
  "the service secret": { kidSecret: undefined, serviceSecret: SERVICE_SECRET },
  "the kid secret": { kidSecret: KID_SECRET, serviceSecret: undefined },
  "both secrets": { kidSecret: KID_SECRET, serviceSecret: SERVICE_SECRET },
} as const satisfies Record<string, ArcKidSecrets>;

/** Sets the app's kid MAC secrets as it reads them, from `process.env`; an unset one is deleted. */
export function appHolds(holds: ArcKidSecrets): void {
  for (const [name, value] of [
    ["OSN_ARC_KID_SECRET", holds.kidSecret],
    ["INTERNAL_SERVICE_SECRET", holds.serviceSecret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** How far ahead osn-api reads a kid's expiry: a key's life and five minutes. */
const MAX_KEY_LIFE_SECONDS = 4 * 3_600 + 300;

/**
 * osn-api's answer to the key route, as it gives it: with `?kid=`, the keys
 * published under the ask's `<uuid>.<expiry>`, none for an ask osn-api cannot
 * read; without, the whole list. It checks no MAC here: osn-api's own tests do.
 */
function answerFor(keys: { kid: string }[], ask: string | null): { kid: string }[] {
  if (ask === null) return keys;
  const id = readArcKeyAsk(ask, Math.floor(Date.now() / 1000), MAX_KEY_LIFE_SECONDS);
  if (id === null) return [];
  return keys.filter((key) => key.kid === id || key.kid.startsWith(`${id}.`));
}

/**
 * An osn-api stand-in for ARC: one published key, served by kid
 * ({@link answerFor}) at
 * `<issuer>/.well-known/arc-jwks.json` (every other fetch goes through,
 * and each fetch of the set is counted), its kid minted holding `osnHolds`,
 * the app holding `holds` ({@link appHolds}), and tokens signed with that
 * key. Both default to both secrets. `restore` undoes all three.
 */
export async function osnArc(
  osnHolds: ArcKidSecrets = HOLDS["both secrets"],
  holds: ArcKidSecrets = HOLDS["both secrets"],
) {
  const pair = await generateArcKeyPair();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const kid = await mintArcKid(osnHolds, expiresAt);
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
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== `${OSN_ISSUER}/.well-known/arc-jwks.json`)
      return original(input, init);
    fetches += 1;
    return Response.json({ keys: answerFor(keys, url.searchParams.get("kid")) });
  }) as typeof fetch;
  appHolds(holds);
  clearJwksCache();
  const verification: OsnTokenVerification = {
    jwksUrl: `${OSN_ISSUER}/.well-known/jwks.json`,
    issuer: OSN_ISSUER,
  };
  const tokenUnderKid = async (scope: string, otherKid: string) => {
    keys.push({ ...jwk, kid: otherKid });
    return `ARC ${await signArcToken(pair.privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope,
      kid: otherKid,
    })}`;
  };
  return {
    verification,
    /** `Authorization: ARC <token>` for `scope`, from osn-api to Zap unless told otherwise. */
    token: async (scope: string, claims: { iss?: string; aud?: string } = {}) =>
      `ARC ${await signArcToken(pair.privateKey, {
        iss: claims.iss ?? "osn-api",
        aud: claims.aud ?? "zap-api",
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
    tokenUnderKid,
    /**
     * A token signed with a published key whose kid osn-api minted holding
     * `minterHolds`, as it does before or after it is given the kid secret.
     */
    tokenFromOsnHolding: async (scope: string, minterHolds: ArcKidSecrets) =>
      tokenUnderKid(scope, await mintArcKid(minterHolds, expiresAt)),
    restore: () => {
      globalThis.fetch = original;
      appHolds(HOLDS.nothing);
      clearJwksCache();
    },
  };
}
