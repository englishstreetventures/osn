import { SignJWT, jwtVerify, importJWK, exportJWK } from "jose";
import { Effect, Data } from "effect";
import { eq } from "drizzle-orm";
import { Db } from "@osn/db/service";
import { serviceAccounts } from "@osn/db";
import {
  classifyArcVerifyError,
  metricArcPublicKeyCacheHit,
  metricArcPublicKeyCacheMiss,
  metricArcTokenCacheHit,
  metricArcTokenCacheMiss,
  metricArcTokenIssued,
  metricArcTokenVerification,
} from "./arc-metrics";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ArcTokenError extends Data.TaggedError("ArcTokenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArcTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly scope: string;
}

export interface ArcTokenPayload extends ArcTokenClaims {
  readonly iat: number;
  readonly exp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARC_ALG = "ES256";
const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const CACHE_REISSUE_BUFFER_SECONDS = 30;
const MAX_CACHE_SIZE = 1000;
const SCOPE_PATTERN = /^[a-z0-9_:]+$/;

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
 * Imports a JWK (JSON string or object) to a CryptoKey.
 * Validates that the JWK is an ES256 (EC P-256) key before importing.
 */
export async function importKeyFromJwk(jwk: string | Record<string, unknown>): Promise<CryptoKey> {
  const parsed = typeof jwk === "string" ? (JSON.parse(jwk) as Record<string, unknown>) : jwk;
  validateEs256Jwk(parsed);
  return importJWK(parsed, ARC_ALG) as Promise<CryptoKey>;
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/** Normalises and validates a comma-separated scope string. */
function normaliseScopes(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Validates that every scope token matches the allowed pattern. */
function validateScopeFormat(scopes: string[]): void {
  for (const s of scopes) {
    if (!SCOPE_PATTERN.test(s)) {
      throw new ArcTokenError({ message: `Invalid scope format: "${s}"` });
    }
  }
}

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

function validateTtl(ttl: number): void {
  if (ttl <= 0 || ttl > 600) {
    throw new ArcTokenError({
      message: `Invalid TTL: ${ttl}. Must be between 1 and 600 seconds.`,
    });
  }
}

/**
 * Creates a signed ARC token (ES256 JWT).
 *
 * @param privateKey - The calling service's private key
 * @param claims - iss (issuer service ID), aud (target service), scope (permissions)
 * @param ttl - Time-to-live in seconds (default: 300 = 5 minutes)
 */
export async function createArcToken(
  privateKey: CryptoKey,
  claims: ArcTokenClaims,
  ttl: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  validateTtl(ttl);

  const scopes = normaliseScopes(claims.scope);
  validateScopeFormat(scopes);

  const token = await new SignJWT({ scope: scopes.join(",") })
    .setProtectedHeader({ alg: ARC_ALG })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);

  metricArcTokenIssued(claims.iss, claims.aud);
  return token;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verifies an ARC token's signature, expiry, audience, and scope.
 *
 * @param token - The JWT string
 * @param publicKey - The issuer's public key
 * @param expectedAudience - The service ID that this token should be addressed to
 * @param requiredScope - If provided, the token must include this scope
 */
export async function verifyArcToken(
  token: string,
  publicKey: CryptoKey,
  expectedAudience: string,
  requiredScope?: string,
): Promise<ArcTokenPayload> {
  // We don't know the issuer until we've parsed the token, so we record
  // the metric once we have it. On early failure (bad signature, etc.)
  // we label with "unknown" so the counter still increments.
  let issForMetric = "unknown";
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [ARC_ALG],
      audience: expectedAudience,
    }).catch((cause) => {
      throw new ArcTokenError({ message: "ARC token verification failed", cause });
    });

    if (typeof payload.iss === "string") issForMetric = payload.iss;

    const scope = payload.scope as string | undefined;
    if (!scope) {
      throw new ArcTokenError({ message: "ARC token missing scope claim" });
    }

    if (requiredScope) {
      const scopes = normaliseScopes(scope);
      if (!scopes.includes(requiredScope.trim().toLowerCase())) {
        throw new ArcTokenError({
          message: `ARC token missing required scope: ${requiredScope}`,
        });
      }
    }

    metricArcTokenVerification(issForMetric, "ok");

    return {
      iss: payload.iss!,
      aud: (Array.isArray(payload.aud) ? payload.aud[0] : payload.aud)!,
      scope,
      iat: payload.iat!,
      exp: payload.exp!,
    };
  } catch (err) {
    metricArcTokenVerification(issForMetric, classifyArcVerifyError(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public key resolution (Effect-based, requires Db)
// ---------------------------------------------------------------------------

/** In-memory cache for resolved CryptoKeys (service_id → { key, expiresAt }). */
const publicKeyCache = new Map<string, { key: CryptoKey; expiresAt: number }>();
const PUBLIC_KEY_CACHE_TTL_SECONDS = 300; // 5 min

/**
 * Resolves a service's public key from the `service_accounts` table.
 * Also validates that the token's scopes are within the service's `allowed_scopes`.
 *
 * Results are cached in-memory for 5 minutes to avoid repeated DB + JWK import.
 */
export const resolvePublicKey = (
  issuer: string,
  tokenScopes?: string[],
): Effect.Effect<CryptoKey, ArcTokenError, Db> =>
  Effect.gen(function* () {
    const now = Math.floor(Date.now() / 1000);

    // Check CryptoKey cache first. Cache entries only exist for
    // issuers we've already verified against the DB, so recording the
    // hit metric with `issuer` here is safe (S-C2).
    const cached = publicKeyCache.get(issuer);
    if (cached && cached.expiresAt > now) {
      // Still need to validate scopes against DB if tokenScopes provided
      // but skip the DB query for key material — we fetch allowedScopes below
      if (!tokenScopes || tokenScopes.length === 0) {
        metricArcPublicKeyCacheHit(issuer);
        return cached.key;
      }
    }

    // S-C2: do NOT record the miss metric yet. At this point `issuer`
    // is attacker-controlled (it's the `iss` claim of an unverified
    // token). Recording it as a metric label would let anyone explode
    // cardinality. Defer until the DB lookup confirms the issuer
    // exists in `service_accounts`.
    const { db } = yield* Db;

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            publicKeyJwk: serviceAccounts.publicKeyJwk,
            allowedScopes: serviceAccounts.allowedScopes,
          })
          .from(serviceAccounts)
          .where(eq(serviceAccounts.serviceId, issuer))
          .limit(1),
      catch: (cause) => new ArcTokenError({ message: "Failed to query service_accounts", cause }),
    });

    if (rows.length === 0) {
      // Unknown issuer — record the miss against the "unknown" bucket
      // so we still observe the probe volume.
      metricArcPublicKeyCacheMiss("unknown");
      return yield* Effect.fail(new ArcTokenError({ message: `Unknown service: ${issuer}` }));
    }

    // Issuer verified — safe to record against the real service ID.
    metricArcPublicKeyCacheMiss(issuer);

    const { publicKeyJwk, allowedScopes } = rows[0];

    // Validate token scopes against registered allowedScopes
    if (tokenScopes && tokenScopes.length > 0) {
      const allowed = normaliseScopes(allowedScopes);
      for (const s of tokenScopes) {
        if (!allowed.includes(s.trim().toLowerCase())) {
          return yield* Effect.fail(
            new ArcTokenError({
              message: `Service "${issuer}" not authorised for scope: ${s}`,
            }),
          );
        }
      }
    }

    // Use cached CryptoKey if still valid (we only needed DB for scope check)
    if (cached && cached.expiresAt > now) {
      return cached.key;
    }

    const key = yield* Effect.tryPromise({
      try: () => importKeyFromJwk(publicKeyJwk),
      catch: (cause) => new ArcTokenError({ message: `Invalid public key for ${issuer}`, cause }),
    });

    // Cache the resolved CryptoKey
    publicKeyCache.set(issuer, { key, expiresAt: now + PUBLIC_KEY_CACHE_TTL_SECONDS });

    return key;
  });

/**
 * Clears the public key cache. Useful for testing and key rotation.
 */
export function clearPublicKeyCache(): void {
  publicKeyCache.clear();
}

// ---------------------------------------------------------------------------
// In-memory token cache (bounded)
// ---------------------------------------------------------------------------

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number; // Unix timestamp in seconds
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(iss: string, aud: string, scope: string): string {
  return `${iss}:${aud}:${scope}`;
}

/**
 * Returns a cached ARC token if it's still valid (with 30s buffer),
 * or creates a new one. The cache is bounded to MAX_CACHE_SIZE entries;
 * expired entries are evicted on every call.
 */
export async function getOrCreateArcToken(
  privateKey: CryptoKey,
  claims: ArcTokenClaims,
  ttl: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  validateTtl(ttl);

  const key = cacheKey(claims.iss, claims.aud, claims.scope);
  const now = Math.floor(Date.now() / 1000);

  // Auto-evict expired entries on every access
  evictExpiredTokens();

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - CACHE_REISSUE_BUFFER_SECONDS > now) {
    metricArcTokenCacheHit(claims.iss);
    return cached.token;
  }

  metricArcTokenCacheMiss(claims.iss);
  const token = await createArcToken(privateKey, claims, ttl);

  // Enforce max cache size — evict oldest entry if full
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }

  tokenCache.set(key, { token, expiresAt: now + ttl });
  return token;
}

/**
 * Clears all cached tokens. Useful for testing.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Evicts expired entries from the token cache.
 * Called automatically by getOrCreateArcToken on every access.
 */
export function evictExpiredTokens(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(key);
    }
  }
}

/** Exposed for testing — returns the current token cache size. */
export function tokenCacheSize(): number {
  return tokenCache.size;
}
