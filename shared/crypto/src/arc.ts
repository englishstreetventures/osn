import { serviceAccounts, serviceAccountKeys } from "@osn/db";
import { Db } from "@osn/db/service";
import { and, eq, isNull, gt, or } from "drizzle-orm";
import { Effect, Data } from "effect";
import { SignJWT, jwtVerify, importJWK, exportJWK } from "jose";

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
  /** Key ID — identifies which public key to use for verification. Becomes the `kid` JWT header. */
  readonly kid: string;
}

/** Verified payload claims returned from verifyArcToken. Does not include `kid` (a JWT header field). */
export interface ArcTokenPayload {
  readonly iss: string;
  readonly aud: string;
  readonly scope: string;
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
    .setProtectedHeader({ alg: ARC_ALG, kid: claims.kid })
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

/**
 * In-memory cache for resolved CryptoKeys.
 * `allowedScopes` is stored as a pre-parsed `Set<string>` to avoid
 * re-splitting the comma string on every cache-hit scope check (P-W2).
 */
const publicKeyCache = new Map<
  string,
  { key: CryptoKey; allowedScopes: Set<string>; expiresAt: number }
>();
/**
 * Last-access timestamps for LRU eviction (P-W1).
 * Updated on every cache hit; scanned only at insert time (DB-miss path).
 * Avoids the Map delete+re-insert on the hot cache-hit path.
 */
const publicKeyLastAccess = new Map<string, number>();
const PUBLIC_KEY_CACHE_TTL_SECONDS = 300; // 5 min

// Mutable cap — overrideable in tests via _setPublicKeyCacheMaxSizeForTest.
let _publicKeyCacheMaxSize = MAX_CACHE_SIZE;

/**
 * Resolves a service's public key from the `service_account_keys` table by `kid`.
 * Also validates that `serviceId == issuer` and the token's scopes are within
 * the service's `allowed_scopes` (from `service_accounts`).
 *
 * Results are cached in-memory for 5 minutes (by `kid`) to avoid repeated
 * DB + JWK import. Revoked and expired keys are never cached. On cache hit,
 * scope validation runs against the cached `allowedScopes` — no DB round-trip.
 */
export const resolvePublicKey = (
  kid: string,
  issuer: string,
  tokenScopes?: string[],
): Effect.Effect<CryptoKey, ArcTokenError, Db> =>
  Effect.gen(function* () {
    const now = Math.floor(Date.now() / 1000);

    // Cache hit path — validate scopes against stored allowedScopes so we
    // never skip scope enforcement even when tokenScopes is omitted (S-M102).
    const cached = publicKeyCache.get(kid);
    if (cached && cached.expiresAt > now) {
      if (tokenScopes && tokenScopes.length > 0) {
        for (const s of tokenScopes) {
          if (!cached.allowedScopes.has(s.trim().toLowerCase())) {
            return yield* Effect.fail(
              new ArcTokenError({
                message: `Service "${issuer}" not authorised for scope: ${s}`,
              }),
            );
          }
        }
      }
      // LRU touch: record access time in ms (P-W1). Side-map write is O(1)
      // and avoids Map delete+re-insert on the hot cache-hit path. Using
      // Date.now() (ms) gives sub-second precision for test determinism.
      publicKeyLastAccess.set(kid, Date.now());
      metricArcPublicKeyCacheHit(issuer);
      return cached.key;
    }

    // S-C2: do NOT record the miss metric yet — `kid` and `issuer` are
    // attacker-controlled (unverified JWT fields). Defer until the DB
    // lookup confirms the key exists and belongs to the issuer.
    const { db } = yield* Db;

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            publicKeyJwk: serviceAccountKeys.publicKeyJwk,
            allowedScopes: serviceAccounts.allowedScopes,
          })
          .from(serviceAccountKeys)
          .innerJoin(serviceAccounts, eq(serviceAccountKeys.serviceId, serviceAccounts.serviceId))
          .where(
            and(
              eq(serviceAccountKeys.keyId, kid),
              eq(serviceAccountKeys.serviceId, issuer),
              isNull(serviceAccountKeys.revokedAt),
              or(isNull(serviceAccountKeys.expiresAt), gt(serviceAccountKeys.expiresAt, now)),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new ArcTokenError({ message: "Failed to query service_account_keys", cause }),
    });

    if (rows.length === 0) {
      // Unknown or revoked/expired key — record against "unknown" bucket.
      metricArcPublicKeyCacheMiss("unknown");
      return yield* Effect.fail(
        new ArcTokenError({ message: `Unknown or invalid key: ${kid} for service: ${issuer}` }),
      );
    }

    // Key verified against DB — safe to record the metric.
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

    const key = yield* Effect.tryPromise({
      try: () => importKeyFromJwk(publicKeyJwk),
      catch: (cause) => new ArcTokenError({ message: `Invalid public key for ${issuer}`, cause }),
    });

    // Cache the resolved CryptoKey. Store allowedScopes as a Set for O(1)
    // hit-path scope checks (P-W2). LRU eviction scans the side-timestamp map
    // to find the least-recently-used entry (P-W1) — O(n) but only on the
    // slow DB-miss path.
    if (publicKeyCache.size >= _publicKeyCacheMaxSize) {
      let lruKid: string | undefined;
      let lruTime = Infinity;
      for (const [k, t] of publicKeyLastAccess) {
        if (t < lruTime) {
          lruTime = t;
          lruKid = k;
        }
      }
      if (lruKid !== undefined) {
        publicKeyCache.delete(lruKid);
        publicKeyLastAccess.delete(lruKid);
      }
    }
    publicKeyCache.set(kid, {
      key,
      allowedScopes: new Set(normaliseScopes(allowedScopes)),
      expiresAt: now + PUBLIC_KEY_CACHE_TTL_SECONDS,
    });
    publicKeyLastAccess.set(kid, Date.now());

    return key;
  });

/**
 * Clears the public key cache. Useful for testing.
 */
export function clearPublicKeyCache(): void {
  publicKeyCache.clear();
  publicKeyLastAccess.clear();
}

/**
 * Evicts a single entry from the public key cache by `kid`.
 * Call immediately after revoking a key so the revocation takes effect in
 * this process without waiting for the 5-minute cache TTL to expire (S-H100).
 */
export function evictPublicKeyCacheEntry(kid: string): void {
  publicKeyCache.delete(kid);
  publicKeyLastAccess.delete(kid);
}

/** Returns the current public key cache size. Useful for testing. */
export function publicKeyCacheSize(): number {
  return publicKeyCache.size;
}

/**
 * Overrides the public key cache max size. **Tests only** — restores to
 * MAX_CACHE_SIZE in the same afterEach that calls clearPublicKeyCache().
 */
export function _setPublicKeyCacheMaxSizeForTest(n: number): void {
  _publicKeyCacheMaxSize = n;
}

/** Resets the public key cache max size to the production default. */
export function _resetPublicKeyCacheMaxSize(): void {
  _publicKeyCacheMaxSize = MAX_CACHE_SIZE;
}

// ---------------------------------------------------------------------------
// In-memory token cache (bounded)
// ---------------------------------------------------------------------------

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number; // Unix timestamp in seconds
}

const tokenCache = new Map<string, CachedToken>();
const tokenLastAccess = new Map<string, number>();

function cacheKey(kid: string, iss: string, aud: string, scope: string): string {
  return `${kid}:${iss}:${aud}:${scope}`;
}

/**
 * Returns a cached ARC token if it's still valid (with 30s buffer),
 * or creates a new one. The cache is bounded to MAX_CACHE_SIZE entries;
 * expired entries are evicted at most once per 30 seconds (P-W102).
 */
export async function getOrCreateArcToken(
  privateKey: CryptoKey,
  claims: ArcTokenClaims,
  ttl: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  validateTtl(ttl);

  const key = cacheKey(claims.kid, claims.iss, claims.aud, claims.scope);
  const now = Math.floor(Date.now() / 1000);

  // Debounced eviction — avoid O(n) scan on every outbound S2S request (P-W102).
  maybeSweepExpiredTokens();

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - CACHE_REISSUE_BUFFER_SECONDS > now) {
    tokenLastAccess.set(key, Date.now());
    metricArcTokenCacheHit(claims.iss);
    return cached.token;
  }

  metricArcTokenCacheMiss(claims.iss);
  const token = await createArcToken(privateKey, claims, ttl);

  // Enforce max cache size — evict LRU entry if full (P-I2).
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    let lruKey: string | undefined;
    let lruTime = Infinity;
    for (const [k, t] of tokenLastAccess) {
      if (t < lruTime) {
        lruTime = t;
        lruKey = k;
      }
    }
    if (lruKey !== undefined) {
      tokenCache.delete(lruKey);
      tokenLastAccess.delete(lruKey);
    }
  }

  tokenCache.set(key, { token, expiresAt: now + ttl });
  tokenLastAccess.set(key, Date.now());
  return token;
}

/**
 * Clears all cached tokens. Useful for testing.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
  tokenLastAccess.clear();
  _lastEvictionMs = 0; // reset debounce so the next auto-sweep fires immediately
}

let _lastEvictionMs = 0;
const EVICTION_DEBOUNCE_MS = 30_000; // internal sweep at most once every 30 s

/**
 * Internal debounced sweep — called by getOrCreateArcToken on every access
 * but runs at most once per 30 s to avoid O(n) scanning on the hot S2S
 * request path (P-W102).
 */
function maybeSweepExpiredTokens(): void {
  const nowMs = Date.now();
  if (nowMs - _lastEvictionMs < EVICTION_DEBOUNCE_MS) return;
  _lastEvictionMs = nowMs;
  const now = Math.floor(nowMs / 1000);
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(key);
      tokenLastAccess.delete(key);
    }
  }
}

/**
 * Evicts all expired entries from the token cache immediately (no debounce).
 * Also resets the debounce window so the next automatic sweep can run.
 * Exported for testing and explicit cache management.
 */
export function evictExpiredTokens(): void {
  _lastEvictionMs = Date.now();
  const now = Math.floor(Date.now() / 1000);
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(key);
      tokenLastAccess.delete(key);
    }
  }
}

/** Exposed for testing — returns the current token cache size. */
export function tokenCacheSize(): number {
  return tokenCache.size;
}
