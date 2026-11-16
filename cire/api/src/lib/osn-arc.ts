/**
 * Checks an ARC (service-to-service) token osn-api sent cire-api.
 *
 * osn-api signs each call with a key its isolate published at
 * `<OSN_ISSUER_URL>/.well-known/arc-jwks.json`; cire-api looks the token's key
 * up there through the shared, bounded key cache and checks the signature,
 * `iss` (`osn-api`), `aud` ({@link CIRE_ARC_AUDIENCE}), expiry and scope
 * (`@shared/osn-auth-client/arc`). The issuer origin is the one cire-api
 * already pins for organiser access tokens.
 *
 * cire-api holds no kid secret. The value osn-api keys its kid MACs with,
 * `INTERNAL_SERVICE_SECRET`, is also the bearer of service-key registration on
 * osn-api and zap-api, and cire-api is not trusted with that. Without it the
 * kid's MAC is not checked: a token with a made-up kid costs one fetch of
 * osn-api's public key set before it is refused, and the cache then remembers
 * that kid as unknown for 30 seconds, sharing one fetch between concurrent
 * requests. The key set is public, so that is the load anyone could put on it
 * directly. A token is still authenticated only by its signature.
 */
import { verifyOsnArcToken } from "@shared/osn-auth-client/arc";

/** cire-api's audience on osn-api's tokens. */
export const CIRE_ARC_AUDIENCE = "cire-api";

/** The scopes cire-api lets osn-api use: an account deletion's preview, and its erasure. */
export const OSN_ARC_SCOPES = {
  deletionPreview: "account:deletion-preview",
  erase: "account:erase",
} as const;

const PERMITTED: ReadonlySet<string> = new Set(Object.values(OSN_ARC_SCOPES));

/** Whether `authorization` carries a token osn-api signed for cire-api with `scope`. */
export async function osnArcAdmits(
  authorization: string | null | undefined,
  osnIssuer: string,
  scope: (typeof OSN_ARC_SCOPES)[keyof typeof OSN_ARC_SCOPES],
): Promise<boolean> {
  const verdict = await verifyOsnArcToken(
    authorization ?? undefined,
    { osnIssuer, kidSecret: undefined },
    { audience: CIRE_ARC_AUDIENCE, scope, allowedScopes: PERMITTED },
  );
  return verdict.ok;
}
