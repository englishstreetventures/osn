/**
 * In-process JWKS public key cache for verifying OSN-issued user access tokens.
 *
 * Fetches the OSN API's JWKS endpoint on cache miss and caches resolved
 * CryptoKeys by `${jwksUrl}:${kid}` for JWKS_CACHE_TTL_MS. On verification
 * failure, the cache is bypassed once (refresh path) to handle key rotation.
 *
 * Mirrors pulse/api/src/lib/jwks-cache.ts — when WebSocket transport lands
 * (zap M1), reuse these helpers at the upgrade hook instead of reinventing
 * verification.
 *
 * P-W2: bounded to CACHE_MAX_SIZE entries via LRU eviction.
 * S-M3: cache key includes the JWKS URL so keys from different issuers never
 * collide even if kid values overlap.
 */

import { importKeyFromJwk } from "@shared/crypto";
import { instrumentedFetch } from "@shared/observability/fetch";

import { metricJwksCacheLookup } from "../metrics";

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 256;

interface CachedKey {
  key: CryptoKey;
  fetchedAt: number;
}

const cache = new Map<string, CachedKey>();
const lastAccess = new Map<string, number>();

function cacheKey(kid: string, jwksUrl: string): string {
  return `${jwksUrl}:${kid}`;
}

function evictLru(): void {
  let lruKey: string | undefined;
  let lruTime = Infinity;
  for (const [k, t] of lastAccess) {
    if (t < lruTime) {
      lruTime = t;
      lruKey = k;
    }
  }
  if (lruKey !== undefined) {
    cache.delete(lruKey);
    lastAccess.delete(lruKey);
  }
}

async function fetchPublicKey(kid: string, jwksUrl: string): Promise<CryptoKey | null> {
  let res: Response;
  try {
    res = await instrumentedFetch(jwksUrl);
  } catch (err) {
    metricJwksCacheLookup("miss");
    throw err;
  }

  if (!res.ok) {
    metricJwksCacheLookup("miss");
    return null;
  }

  let body: { keys?: unknown[] };
  try {
    body = (await res.json()) as { keys?: unknown[] };
  } catch {
    metricJwksCacheLookup("miss");
    return null;
  }

  const keys = Array.isArray(body.keys) ? body.keys : [];
  const jwk = keys.find(
    (k): k is Record<string, unknown> =>
      typeof k === "object" && k !== null && (k as Record<string, unknown>)["kid"] === kid,
  );

  if (!jwk) {
    metricJwksCacheLookup("miss");
    return null;
  }

  try {
    return await importKeyFromJwk(jwk);
  } catch {
    metricJwksCacheLookup("miss");
    return null;
  }
}

function storeInCache(ck: string, key: CryptoKey): void {
  if (cache.size >= CACHE_MAX_SIZE) evictLru();
  const now = Date.now();
  cache.set(ck, { key, fetchedAt: now });
  lastAccess.set(ck, now);
}

/**
 * Returns the CryptoKey for `kid` from the cache or the JWKS endpoint.
 * Returns `null` if the key cannot be resolved.
 */
export async function resolvePublicKeyForKid(
  kid: string,
  jwksUrl: string,
): Promise<CryptoKey | null> {
  const ck = cacheKey(kid, jwksUrl);
  const now = Date.now();
  const cached = cache.get(ck);
  if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    lastAccess.set(ck, now);
    metricJwksCacheLookup("hit");
    return cached.key;
  }

  const key = await fetchPublicKey(kid, jwksUrl);
  if (key) {
    storeInCache(ck, key);
    metricJwksCacheLookup("miss");
  }
  return key;
}

/**
 * Bypasses the cache and re-fetches the JWKS endpoint for `kid`. Call this
 * when token verification fails against a cached key — it may have been
 * rotated. Updates the cache on success.
 */
export async function refreshPublicKeyForKid(
  kid: string,
  jwksUrl: string,
): Promise<CryptoKey | null> {
  const key = await fetchPublicKey(kid, jwksUrl);
  if (key) {
    storeInCache(cacheKey(kid, jwksUrl), key);
    metricJwksCacheLookup("refresh");
  }
  return key;
}

/** Clears the key cache. Tests only. */
export function clearJwksCache(): void {
  cache.clear();
  lastAccess.clear();
}
