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
 * Before it fetches, cire-api checks the kid's MAC under `OSN_ARC_KID_SECRET`,
 * the secret osn-api keys one of its kid MACs with for that alone, and refuses
 * a kid with no MAC that verifies under it (`@shared/crypto/arc-kid`). Without
 * that secret, or with one shorter than 32 characters, it checks no MAC and
 * asks osn-api for the kid as it came; osn-api checks the MACs itself, so a
 * made-up kid costs it no read of the database beyond a budgeted one. It
 * never holds `INTERNAL_SERVICE_SECRET`, which keys osn-api's other kid MAC
 * and is the bearer of service-key registration on osn-api and zap-api, so it
 * never accepts a kid on that MAC alone. A token is authenticated by its
 * signature.
 */
import { verifyOsnArcToken } from "@shared/osn-auth-client/arc";

/** cire-api's audience on osn-api's tokens. */
export const CIRE_ARC_AUDIENCE = "cire-api";

/**
 * The scopes cire-api lets osn-api use: an account deletion's preview, its
 * erasure, and the person's section of their account export. Each route asks
 * for its own scope, so a token for one opens no other.
 */
export const OSN_ARC_SCOPES = {
  deletionPreview: "account:deletion-preview",
  erase: "account:erase",
  export: "account:export",
} as const;

const PERMITTED: ReadonlySet<string> = new Set(Object.values(OSN_ARC_SCOPES));

/** Where cire-api finds osn-api's keys, and the secret that gates fetching them. */
export interface CireOsnArc {
  /** osn-api's origin (`OSN_ISSUER_URL`), whose published keys sign its tokens. */
  readonly osnIssuer: string;
  /** `OSN_ARC_KID_SECRET`, when cire-api holds it. */
  readonly kidSecret: string | undefined;
}

/** Whether `authorization` carries a token osn-api signed for cire-api with `scope`. */
export async function osnArcAdmits(
  authorization: string | null | undefined,
  { osnIssuer, kidSecret }: CireOsnArc,
  scope: (typeof OSN_ARC_SCOPES)[keyof typeof OSN_ARC_SCOPES],
): Promise<boolean> {
  const verdict = await verifyOsnArcToken(
    authorization ?? undefined,
    { osnIssuer, kidSecret, serviceSecret: undefined },
    { audience: CIRE_ARC_AUDIENCE, scope, allowedScopes: PERMITTED },
  );
  return verdict.ok;
}
