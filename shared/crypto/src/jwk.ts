import { Data } from "effect";
import { exportJWK, importJWK, calculateJwkThumbprint } from "jose";

// Pure ES256 key/JWK helpers — no DB, no Drizzle, no bun:sqlite. Lives apart
// from arc.ts (which imports @osn/db for DB-backed key resolution) so that
// JWKS-verification consumers — e.g. @shared/osn-auth-client running on
// Cloudflare Workers — can import the key helpers without dragging the
// @osn/db → bun:sqlite chain into a Worker bundle. arc.ts re-imports these and
// the barrel (`@shared/crypto`) re-exports them, so existing call sites are
// unchanged; Worker consumers import from `@shared/crypto/jwk`.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ArcTokenError extends Data.TaggedError("ArcTokenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARC_ALG = "ES256";

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generates an ES256 (ECDSA P-256) key pair for ARC token signing/verification.
 * Returns Web Crypto CryptoKeyPair with extractable keys suitable for JWK export.
 */
export async function generateArcKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, // extractable — needed for JWK export
    ["sign", "verify"],
  );
}

/**
 * Exports a CryptoKey to JWK format (JSON string for DB storage).
 */
export async function exportKeyToJwk(key: CryptoKey): Promise<string> {
  const jwk = await exportJWK(key);
  return JSON.stringify(jwk);
}

/**
 * Validates that a parsed JWK has the expected ES256 (EC P-256) structure.
 * Prevents algorithm confusion attacks from malicious JWK material.
 */
function validateEs256Jwk(jwk: Record<string, unknown>): void {
  if (jwk.kty !== "EC") {
    throw new ArcTokenError({
      message: `Invalid JWK: expected kty "EC", got "${String(jwk.kty)}"`,
    });
  }
  if (jwk.crv !== "P-256") {
    throw new ArcTokenError({
      message: `Invalid JWK: expected crv "P-256", got "${String(jwk.crv)}"`,
    });
  }
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new ArcTokenError({ message: "Invalid JWK: missing x or y coordinates" });
  }
}

/**
 * Computes an RFC 7638 SHA-256 JWK thumbprint for a public key.
 * Stable across restarts for the same key — suitable for use as a `kid`.
 */
export async function thumbprintKid(publicKey: CryptoKey): Promise<string> {
  const jwk = await exportJWK(publicKey);
  return calculateJwkThumbprint(jwk);
}

/**
 * Imports a JWK (JSON string or object) to a CryptoKey.
 * Validates that the JWK is an ES256 (EC P-256) key before importing.
 */
export async function importKeyFromJwk(jwk: string | Record<string, unknown>): Promise<CryptoKey> {
  const parsed = typeof jwk === "string" ? (JSON.parse(jwk) as Record<string, unknown>) : jwk;
  validateEs256Jwk(parsed);
  return importJWK(parsed, ARC_ALG) as Promise<CryptoKey>;
}
