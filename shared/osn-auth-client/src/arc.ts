/**
 * Verifies an ARC (service-to-service) token osn-api sent an app.
 *
 * osn-api signs each call with a key pair its isolate minted, and publishes
 * the public half at `<osn issuer>/.well-known/arc-jwks.json` before it signs
 * anything. The app resolves the token's `kid` against that set through the
 * same bounded kid cache it resolves access-token keys with, so a key
 * published by any osn-api isolate verifies at any app isolate. The issuer
 * origin is the one the app already pins for access tokens: no new address,
 * and the same trust.
 *
 * Before any fetch the token must claim `iss: "osn-api"`, ask for a scope the
 * app lets osn-api use, and, when the app holds an `INTERNAL_SERVICE_SECRET`
 * of at least 32 characters, carry a kid whose MAC verifies and whose expiry
 * has not passed (`@shared/crypto/arc-kid`). A token failing any of these costs no fetch.
 * Then jose checks the signature (ES256 only), `iss`, `aud`, `exp` and `iat`,
 * and the token's scope must hold the route's.
 *
 * Worker-safe: no database, no `@shared/crypto` barrel.
 */

import { checkArcKid } from "@shared/crypto/arc-kid";
import { classifyArcVerifyError, metricArcTokenVerification } from "@shared/crypto/arc-metrics";
import { normaliseScopes } from "@shared/crypto/jwk";
import { decodeJwt, decodeProtectedHeader, errors, jwtVerify } from "jose";

import { resolvePublicKeyForKid } from "./jwks-cache";

/** The `iss` osn-api signs its ARC tokens with. */
export const OSN_ARC_ISSUER = "osn-api";

/** Where osn-api publishes its outbound ARC public keys, below its issuer origin. */
export const OSN_ARC_JWKS_PATH = "/.well-known/arc-jwks.json";

/** Where to find osn-api's keys, and what gates fetching them. */
export interface OsnArcVerification {
  /** osn-api's origin: the issuer the app pins for access tokens. */
  readonly osnIssuer: string;
  /**
   * `INTERNAL_SERVICE_SECRET` when this app holds it; the kid MAC check is
   * skipped without it, and with one shorter than 32 characters.
   */
  readonly kidSecret: string | undefined;
}

/** What one route admits. */
export interface OsnArcExpectation {
  /** This app's ARC audience, e.g. `zap-api`. */
  readonly audience: string;
  /** The scope the route needs. */
  readonly scope: string;
  /** Every scope this app lets osn-api use. */
  readonly allowedScopes: ReadonlySet<string>;
}

/** The verdict: admitted, or refused for a reason the metric records. */
export type OsnArcVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ArcVerifyResult };

/** The bounded results the `arc.token.verification` counter records. */
type ArcVerifyResult = Parameters<typeof metricArcTokenVerification>[1];

const CLAIM_SCOPE = "scope";

function tokenOf(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^ARC\s+(\S+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * The issuer an ARC token claims, unverified, or null when the header holds
 * no readable ARC token. For choosing how to verify it, never for trusting it.
 */
export function peekArcIssuer(authorization: string | undefined): string | null {
  const token = tokenOf(authorization);
  if (!token) return null;
  try {
    const { iss } = decodeJwt(token);
    return typeof iss === "string" ? iss : null;
  } catch {
    return null;
  }
}

function refuse(reason: ArcVerifyResult, issuer = "unknown"): OsnArcVerdict {
  metricArcTokenVerification(issuer, reason);
  return { ok: false, reason };
}

function classify(error: unknown): ArcVerifyResult {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    return error.claim === "aud" ? "audience_mismatch" : "malformed";
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return "bad_signature";
  return classifyArcVerifyError(error);
}

/** Verifies `authorization` as an ARC token osn-api signed for `expected`. */
export async function verifyOsnArcToken(
  authorization: string | undefined,
  verification: OsnArcVerification,
  expected: OsnArcExpectation,
): Promise<OsnArcVerdict> {
  const token = tokenOf(authorization);
  if (!token) return refuse("malformed");

  let kid: string;
  let issuer: unknown;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "ES256" || typeof header.kid !== "string" || header.kid === "") {
      return refuse("malformed");
    }
    kid = header.kid;
    issuer = decodeJwt(token).iss;
  } catch {
    return refuse("malformed");
  }
  if (issuer !== OSN_ARC_ISSUER) return refuse("unknown_issuer");

  const scope = expected.scope.trim().toLowerCase();
  if (!expected.allowedScopes.has(scope)) return refuse("scope_denied", OSN_ARC_ISSUER);

  if (!(await checkArcKid(kid, verification.kidSecret, Math.floor(Date.now() / 1000)))) {
    return refuse("unknown_issuer", OSN_ARC_ISSUER);
  }

  const key = await resolvePublicKeyForKid(kid, `${verification.osnIssuer}${OSN_ARC_JWKS_PATH}`);
  if (!key) return refuse("unknown_issuer", OSN_ARC_ISSUER);

  let granted: unknown;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      issuer: OSN_ARC_ISSUER,
      audience: expected.audience,
      requiredClaims: ["exp", "iat", "iss", "aud"],
    });
    granted = payload[CLAIM_SCOPE];
  } catch (error) {
    return refuse(classify(error), OSN_ARC_ISSUER);
  }
  if (typeof granted !== "string" || !normaliseScopes(granted).includes(scope)) {
    return refuse("scope_denied", OSN_ARC_ISSUER);
  }
  metricArcTokenVerification(OSN_ARC_ISSUER, "ok");
  return { ok: true };
}
