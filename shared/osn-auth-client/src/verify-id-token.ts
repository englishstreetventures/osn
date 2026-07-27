import { decodeProtectedHeader, errors, jwtVerify } from "jose";

import { refreshPublicKeyForKid, resolvePublicKeyForKid } from "./jwks-cache";

/**
 * OIDC ID-token verifier.
 *
 * Separate from `extractClaims` on purpose. `extractClaims` verifies a USER
 * ACCESS token, where `sub` IS the `usr_*` profile id. An ID token's `sub` is
 * the PAIRWISE `pw_*` subject — per client sector, deliberately not the profile
 * id — so reading `sub` as a profile id there would silently key every row on a
 * value that means nothing to the graph. The real profile id rides in the
 * first-party-only `osn_profile_id` claim, which `extractClaims` does not carry.
 *
 * Signature:
 *   verifyIdToken(token, jwksUrl, { issuer, audience, nonce?, testKey? })
 *
 * - `issuer`   — REQUIRED. The ID token's `iss` must match exactly. Unlike the
 *                access-token path (where `iss` is optional for X2 rollout
 *                safety), an OIDC client always knows its provider.
 * - `audience` — REQUIRED. Our `client_id`. An ID token minted for a different
 *                client must never authenticate a session here.
 * - `nonce`    — the value we sent on the authorize request. When set, a
 *                missing or mismatched `nonce` is a hard failure: this is the
 *                only thing binding the token to OUR authorize request rather
 *                than a replayed one.
 * - `testKey`  — injected verifying key for tests (skips the JWKS fetch).
 *
 * Returns `null` for any failure — never throws, never says which check failed.
 *
 * Amplification defence (P-C1): mirrors `extractClaims`. Only a signature
 * mismatch against a successfully-resolved key triggers the one-shot JWKS
 * refresh; expiry, wrong `aud`/`iss`, and a bad `nonce` are terminal, because a
 * fresh key cannot change any of them.
 */

export type IdTokenClaims = {
  /** Pairwise subject — stable per (client sector, account), NOT a profile id. */
  sub: string;
  /**
   * The real `usr_*` profile id. Only present for first-party clients; `null`
   * for everyone else, and `null` is a refusal signal, not a default.
   */
  osnProfileId: string | null;
  email: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Seconds since epoch of the actual authentication event, when present. */
  authTime: number | null;
};

export type VerifyIdTokenOptions = {
  /** Expected `iss` — required, enforced inside the jwtVerify pass. */
  issuer: string;
  /** Expected `aud` — our client id, required. */
  audience: string;
  /** The `nonce` we sent on the authorize request; enforced when set. */
  nonce?: string;
  /** Injected verifying key for tests (skips JWKS fetch). */
  testKey?: CryptoKey;
};

/** Allowed clock skew (seconds) — matches the ARC / W6 issuer contract. */
const CLOCK_TOLERANCE_SECONDS = 30;

type VerifyOutcome =
  | { kind: "ok"; claims: IdTokenClaims }
  /** Signature did not validate against this (possibly stale) key. */
  | { kind: "signature-mismatch" }
  /** Expired, wrong `aud`/`iss`/`nonce`, malformed — a fresh key cannot help. */
  | { kind: "terminal" };

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

async function verifyWithKey(
  token: string,
  key: CryptoKey,
  options: VerifyIdTokenOptions,
): Promise<VerifyOutcome> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      audience: options.audience,
      issuer: options.issuer,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });

    const sub = stringOrNull(payload.sub);
    if (!sub) return { kind: "terminal" };

    // Replay binding. A token whose nonce is absent when we sent one is just as
    // untrustworthy as one whose nonce is wrong — both mean it did not come
    // back from the authorize request this browser started.
    if (options.nonce !== undefined && payload["nonce"] !== options.nonce) {
      return { kind: "terminal" };
    }

    return {
      kind: "ok",
      claims: {
        sub,
        osnProfileId: stringOrNull(payload["osn_profile_id"]),
        email: stringOrNull(payload["email"]),
        handle: stringOrNull(payload["preferred_username"]),
        displayName: stringOrNull(payload["name"]),
        avatarUrl: stringOrNull(payload["picture"]),
        authTime: typeof payload["auth_time"] === "number" ? payload["auth_time"] : null,
      },
    };
  } catch (err) {
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      return { kind: "signature-mismatch" };
    }
    return { kind: "terminal" };
  }
}

export async function verifyIdToken(
  token: string,
  jwksUrl: string,
  options: VerifyIdTokenOptions,
): Promise<IdTokenClaims | null> {
  let header: { kid?: string; alg?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string") return null;
  const kid = header.kid;

  if (options.testKey) {
    const outcome = await verifyWithKey(token, options.testKey, options);
    return outcome.kind === "ok" ? outcome.claims : null;
  }

  // Unknown kid / failed fetch is terminal — `resolve` already hit upstream (or
  // the negative cache said not to bother). Forcing a refresh here would bypass
  // that negative cache and re-open the junk-kid amplification hole (P-C1).
  const key = await resolvePublicKeyForKid(kid, jwksUrl);
  if (!key) return null;

  const outcome = await verifyWithKey(token, key, options);
  if (outcome.kind === "ok") return outcome.claims;
  if (outcome.kind !== "signature-mismatch") return null;

  const freshKey = await refreshPublicKeyForKid(kid, jwksUrl);
  if (!freshKey) return null;
  const retried = await verifyWithKey(token, freshKey, options);
  return retried.kind === "ok" ? retried.claims : null;
}
