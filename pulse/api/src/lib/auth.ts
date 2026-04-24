import { decodeProtectedHeader, jwtVerify } from "jose";

import { resolvePublicKeyForKid, refreshPublicKeyForKid } from "./jwks-cache";

/**
 * Shared JWT claims extractor.
 *
 * Pulse trusts user access tokens minted by osn/api. Keys are fetched
 * from the issuer's JWKS (with cache + single-shot refresh on miss),
 * and we never accept tokens that aren't ES256 or lack a `kid` header.
 *
 * Routes should import `extractClaims` and pass the route-level
 * `jwksUrl` + optional `_testKey` straight through. Returns `null` for
 * any failure — never throws, never differentiates reasons (routes map
 * to 401 uniformly).
 */

export type Claims = {
  profileId: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
};

async function verifyTokenWithKey(token: string, key: CryptoKey): Promise<Claims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"] });
    const profileId = typeof payload.sub === "string" ? payload.sub : null;
    if (!profileId) return null;
    return {
      profileId,
      email: typeof payload.email === "string" ? payload.email : null,
      handle: typeof payload.handle === "string" ? payload.handle : null,
      displayName: typeof payload.displayName === "string" ? payload.displayName : null,
    };
  } catch {
    return null;
  }
}

export async function extractClaims(
  authHeader: string | undefined,
  jwksUrl: string,
  _testKey?: CryptoKey,
): Promise<Claims | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  let header: { kid?: string; alg?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string") return null;
  const kid = header.kid;

  if (_testKey) return verifyTokenWithKey(token, _testKey);

  const key = await resolvePublicKeyForKid(kid, jwksUrl);
  if (key) {
    const result = await verifyTokenWithKey(token, key);
    if (result) return result;
  }

  const freshKey = await refreshPublicKeyForKid(kid, jwksUrl);
  if (!freshKey) return null;
  return verifyTokenWithKey(token, freshKey);
}

export const DEFAULT_JWKS_URL =
  process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";
