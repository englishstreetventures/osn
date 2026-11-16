/**
 * ARC (service-to-service) verification for pulse-api's `/internal/*` routes.
 *
 * osn-api is the only service that calls them. It publishes the public half
 * of each key it signs with at `<osn issuer>/.well-known/arc-jwks.json`, and
 * Pulse verifies its tokens against that set through
 * `@shared/osn-auth-client/arc`, so a key any osn-api isolate published
 * verifies at any Pulse isolate, with nothing registered here. The issuer
 * origin is the one Pulse already pins for access tokens.
 */
import { verifyOsnArcToken, type OsnArcVerification } from "@shared/osn-auth-client/arc";

/** Pulse's ARC audience. */
export const PULSE_ARC_AUDIENCE = "pulse-api";

/** Every scope Pulse lets osn-api use: erasure, export, the deletion preview and the session end. */
export const PERMITTED_OSN_SCOPES: ReadonlySet<string> = new Set([
  "account:erase",
  "account:export",
  "account:deletion-preview",
  "account:sessions-revoke",
]);

/**
 * Admits a call osn-api signed for Pulse with `scope`; otherwise sets 401 and
 * answers false. Every refusal looks the same to the caller.
 */
export async function requireOsnArc(
  authorization: string | undefined,
  set: { status?: number | string },
  verification: OsnArcVerification,
  scope: string,
): Promise<boolean> {
  const verdict = await verifyOsnArcToken(authorization, verification, {
    audience: PULSE_ARC_AUDIENCE,
    scope,
    allowedScopes: PERMITTED_OSN_SCOPES,
  });
  if (!verdict.ok) set.status = 401;
  return verdict.ok;
}
