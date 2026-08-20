import { Data } from "effect";
import { SignJWT, exportJWK, importJWK, calculateJwkThumbprint } from "jose";

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
 * An ES256 (EC P-256) JWK, as this module accepts one. `d` is the private
 * scalar — present on a private key, absent on a public one. A JWKS entry may
 * carry further registry members (`use`, `key_ops`, `x5c`, …); they are not
 * read here and pass through to `importJWK` untouched.
 */
export interface Es256Jwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  /** Base64url x coordinate. */
  readonly x: string;
  /** Base64url y coordinate. */
  readonly y: string;
  /** Base64url private scalar — private keys only. */
  readonly d?: string;
  /** Key ID, when the publisher set one (JWKS entries carry one). */
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
}

/**
 * Validates that a parsed JWK has the expected ES256 (EC P-256) structure.
 * Prevents algorithm confusion attacks from malicious JWK material.
 */
function validateEs256Jwk(jwk: unknown): asserts jwk is Es256Jwk {
  if (typeof jwk !== "object" || jwk === null) {
    throw new ArcTokenError({ message: `Invalid JWK: expected an object, got "${typeof jwk}"` });
  }
  const kty = "kty" in jwk ? jwk.kty : undefined;
  if (kty !== "EC") {
    throw new ArcTokenError({
      message: `Invalid JWK: expected kty "EC", got "${String(kty)}"`,
    });
  }
  const crv = "crv" in jwk ? jwk.crv : undefined;
  if (crv !== "P-256") {
    throw new ArcTokenError({
      message: `Invalid JWK: expected crv "P-256", got "${String(crv)}"`,
    });
  }
  const x = "x" in jwk ? jwk.x : undefined;
  const y = "y" in jwk ? jwk.y : undefined;
  if (typeof x !== "string" || typeof y !== "string") {
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
 * Imports a JWK (JSON string or already-parsed value) to a CryptoKey.
 *
 * The input is untrusted — DB rows, env vars and fetched JWKS documents all
 * land here — so it is parsed and validated into an `Es256Jwk` first. Anything
 * that is not an ES256 (EC P-256) key throws `ArcTokenError`.
 */
export async function importKeyFromJwk(jwk: unknown): Promise<CryptoKey> {
  const parsed: unknown = typeof jwk === "string" ? JSON.parse(jwk) : jwk;
  validateEs256Jwk(parsed);
  return importJWK(parsed, ARC_ALG) as Promise<CryptoKey>;
}

// ---------------------------------------------------------------------------
// ARC token signing (pure — no DB, no metrics)
//
// The signing primitive lives here, alongside the key helpers, so Worker
// consumers (cire/api on Cloudflare Workers) can MINT ARC tokens via
// `@shared/crypto/jwk` without dragging the @osn/db → bun:sqlite chain (in
// arc.ts) or the node OpenTelemetry SDK (via arc-metrics.ts) into the Worker
// bundle. arc.ts wraps `signArcToken` to add the `arc.token.issued` metric for
// the bun/node services; the barrel re-exports both.
// ---------------------------------------------------------------------------

/** Default ARC token TTL — 5 minutes. */
export const ARC_DEFAULT_TTL_SECONDS = 300;

/**
 * Scopes are lowercase identifiers with `:` / `_` / `-` separators
 * (e.g. `graph:read`, `step-up:verify`, `app-enrollment:write`).
 *
 * The hyphen matters: the deployed scope taxonomy (osn-api
 * `PERMITTED_SCOPES`) contains hyphenated scopes, and until 2026-07 this
 * pattern rejected them — every Flow B leave-app token mint
 * (`pulse/api/src/lib/osn-bridge.ts`) threw `Invalid scope format` at
 * runtime. Regression-tested in `tests/jwk-sign.test.ts`.
 */
const SCOPE_PATTERN = /^[a-z0-9_:-]+$/;

export interface ArcTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly scope: string;
  /** Key ID — identifies which public key to use for verification. Becomes the `kid` JWT header. */
  readonly kid: string;
}

/** Normalises a comma-separated scope string into a trimmed, lowercased list. */
export function normaliseScopes(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Validates that every scope token matches the allowed pattern. */
export function validateScopeFormat(scopes: string[]): void {
  for (const s of scopes) {
    if (!SCOPE_PATTERN.test(s)) {
      throw new ArcTokenError({ message: `Invalid scope format: "${s}"` });
    }
  }
}

/** Rejects TTLs outside the 1–600 second band. */
export function validateTtl(ttl: number): void {
  if (ttl <= 0 || ttl > 600) {
    throw new ArcTokenError({
      message: `Invalid TTL: ${ttl}. Must be between 1 and 600 seconds.`,
    });
  }
}

/**
 * Signs an ARC token (ES256 JWT) — the pure, metric-free signing primitive.
 *
 * Validates the TTL and scope format, then mints a short-lived JWT carrying
 * `iss` / `aud` / `scope`, with `kid` in the protected header. Callers on
 * bun/node should prefer `createArcToken` (from `@shared/crypto`) which adds
 * the issuance metric; Worker callers import this directly from
 * `@shared/crypto/jwk`.
 *
 * @param privateKey - The calling service's ES256 private key
 * @param claims - iss (issuer service ID), aud (target service), scope, kid
 * @param ttl - Time-to-live in seconds (default: 300 = 5 minutes)
 */
export async function signArcToken(
  privateKey: CryptoKey,
  claims: ArcTokenClaims,
  ttl: number = ARC_DEFAULT_TTL_SECONDS,
): Promise<string> {
  validateTtl(ttl);

  const scopes = normaliseScopes(claims.scope);
  validateScopeFormat(scopes);

  // One clock read for both claims. `setIssuedAt()` and a relative
  // `setExpirationTime("300s")` each call Date.now() separately, so a token
  // minted across a second boundary carries exp - iat = ttl + 1 — a lifetime
  // the caller never asked for, and a flaky assertion for anyone checking it.
  const issuedAt = Math.floor(Date.now() / 1000);

  return new SignJWT({ scope: scopes.join(",") })
    .setProtectedHeader({ alg: ARC_ALG, kid: claims.kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .sign(privateKey);
}
