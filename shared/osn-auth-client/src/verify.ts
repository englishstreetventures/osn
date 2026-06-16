import { decodeProtectedHeader, errors, jwtVerify } from "jose";

import { resolvePublicKeyForKid, refreshPublicKeyForKid } from "./jwks-cache";

/**
 * Shared JWT claims extractor.
 *
 * Verifies user access tokens minted by osn/api. Keys are fetched from the
 * issuer's JWKS (with cache + single-shot refresh on miss), and we never
 * accept tokens that aren't ES256 or lack a `kid` header.
 *
 * Signature:
 *   extractClaims(authHeader, jwksUrl, { testKey?, audience?, issuer? })
 *
 * - `jwksUrl`   — the route-level JWKS endpoint, passed straight through.
 * - `testKey`   — injected verifying key for tests (skips the JWKS fetch).
 * - `audience`  — when set, the expected `aud` is enforced *inside* the single
 *                 `jwtVerify` pass (P-I1); a mismatch is terminal (no refetch).
 * - `issuer`    — when set, the expected `iss` is enforced inside the same
 *                 `jwtVerify` pass; a mismatch is terminal (no refetch).
 *                 **Optional and unset by default** — when unset, `iss` is not
 *                 checked, so pre-issuer-stamping tokens still verify (X2
 *                 rollout safety). A fresh JWKS key can neither change a
 *                 token's `iss` nor its `aud`, so neither mismatch warrants a
 *                 refetch.
 *
 * Clock skew (X2): verification allows ±30s of `clockTolerance`, matching the
 * ARC / W6 issuer contract, so small clock drift between issuer and verifier
 * doesn't reject otherwise-valid tokens.
 *
 * Returns `null` for any failure — never throws, never differentiates reasons
 * (callers map to 401 uniformly).
 *
 * Amplification defence (P-C1): only a signature mismatch against a
 * successfully-resolved key triggers the one-shot JWKS refresh. Expired tokens,
 * audience mismatches, and otherwise-malformed/garbage tokens are terminal and
 * return `null` without a second upstream fetch — a fresh key can neither
 * un-expire a token nor change its `aud`.
 */

export type Claims = {
  profileId: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
};

export type ExtractClaimsOptions = {
  /** Injected verifying key for tests (skips JWKS fetch). */
  testKey?: CryptoKey;
  /** Expected `aud` claim — enforced inside the jwtVerify pass when set. */
  audience?: string;
  /**
   * Expected `iss` claim — enforced inside the jwtVerify pass when set.
   * Optional and unset by default (X2): when unset, `iss` is not checked so
   * pre-issuer-stamping tokens still verify. A mismatch is terminal.
   */
  issuer?: string;
};

/** Allowed clock skew (seconds) — matches the ARC / W6 issuer contract (X2). */
const CLOCK_TOLERANCE_SECONDS = 30;

/** Outcome of a single verify attempt against one key. */
type VerifyOutcome =
  /** Token verified — claims extracted. */
  | { kind: "ok"; claims: Claims }
  /**
   * The signature did not validate against this (possibly stale) key. This is
   * the ONLY outcome that justifies a one-shot JWKS refresh.
   */
  | { kind: "signature-mismatch" }
  /**
   * Terminal failure — expired, wrong audience, malformed claims, or any other
   * reason a fresh key could not fix. No refresh.
   */
  | { kind: "terminal" };

async function verifyTokenWithKey(
  token: string,
  key: CryptoKey,
  audience: string | undefined,
  issuer: string | undefined,
): Promise<VerifyOutcome> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      audience,
      // Unset issuer ⇒ omit the option ⇒ jose does not enforce `iss` (X2).
      ...(issuer ? { issuer } : {}),
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    const profileId = typeof payload.sub === "string" ? payload.sub : null;
    if (!profileId) return { kind: "terminal" };
    return {
      kind: "ok",
      claims: {
        profileId,
        email: typeof payload.email === "string" ? payload.email : null,
        handle: typeof payload.handle === "string" ? payload.handle : null,
        displayName: typeof payload.displayName === "string" ? payload.displayName : null,
      },
    };
  } catch (err) {
    // A signature failure is the only thing a key rotation could fix. Expiry,
    // audience mismatch, claim-validation, and any other error are terminal.
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      return { kind: "signature-mismatch" };
    }
    return { kind: "terminal" };
  }
}

export async function extractClaims(
  authHeader: string | undefined,
  jwksUrl: string,
  options?: ExtractClaimsOptions,
): Promise<Claims | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const audience = options?.audience;
  const issuer = options?.issuer;

  let header: { kid?: string; alg?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string") return null;
  const kid = header.kid;

  if (options?.testKey) {
    const outcome = await verifyTokenWithKey(token, options.testKey, audience, issuer);
    return outcome.kind === "ok" ? outcome.claims : null;
  }

  // Unknown kid / failed fetch is terminal — resolve already hit upstream (or
  // the negative cache said not to bother). Falling through to a forced
  // refresh here would bypass the negative cache and re-open the junk-kid
  // amplification hole (P-C1).
  const key = await resolvePublicKeyForKid(kid, jwksUrl);
  if (!key) return null;

  const outcome = await verifyTokenWithKey(token, key, audience, issuer);
  if (outcome.kind === "ok") return outcome.claims;
  // Only a signature mismatch against a successfully-resolved key warrants
  // re-fetching the JWKS (possible rotation). Anything else — including an
  // issuer mismatch — is terminal: a fresh key cannot change a token's `iss`.
  if (outcome.kind !== "signature-mismatch") return null;

  const freshKey = await refreshPublicKeyForKid(kid, jwksUrl);
  if (!freshKey) return null;
  const retried = await verifyTokenWithKey(token, freshKey, audience, issuer);
  return retried.kind === "ok" ? retried.claims : null;
}
