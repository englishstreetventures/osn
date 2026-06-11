/**
 * In-process JWKS public key cache for verifying OSN-issued user access tokens.
 *
 * Fetches the OSN API's JWKS endpoint on cache miss and caches resolved
 * CryptoKeys by `${jwksUrl}:${kid}` for JWKS_CACHE_TTL_MS. On verification
 * failure against a resolved key, the cache is bypassed once (refresh path)
 * to handle key rotation.
 *
 * Amplification defences (P-C1 / S-M3):
 * - Negative cache: an unknown kid (or a fetch that fails) is remembered for
 *   NEGATIVE_TTL_MS so a flood of junk-`kid` tokens doesn't re-hit upstream on
 *   every request. A forced refresh bypasses the negative cache so a genuine
 *   rotation is never masked.
 * - Single-flight: concurrent fetches for the same jwksUrl share one in-flight
 *   promise instead of stampeding the issuer.
 * - Fetch timeout: each JWKS fetch is bounded by JWKS_FETCH_TIMEOUT_MS so a
 *   hung upstream cannot pin the consumer.
 *
 * P-W2: bounded to CACHE_MAX_SIZE entries via LRU eviction — mirrors the
 * pattern in @shared/crypto/arc.ts (PR #63).
 * S-M3: cache key includes the JWKS URL so keys from different issuers never
 * collide even if kid values overlap.
 */

// Deep import from the DB-free `/jwk` entry, not the barrel: the barrel pulls
// arc.ts → @osn/db → bun:sqlite, which can't bundle for Cloudflare Workers
// (cire/api's organiser-auth middleware runs there). See @shared/crypto/jwk.
import { importKeyFromJwk } from "@shared/crypto/jwk";

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Negative-cache TTL for unknown kids / failed fetches (P-C1 amplification). */
const NEGATIVE_TTL_MS = 30 * 1000; // 30 seconds
/** Upper bound on a single JWKS fetch so a hung upstream can't pin us. */
const JWKS_FETCH_TIMEOUT_MS = 5000;
// P-W2: realistic key-rotation scenarios will never exceed single digits;
// cap prevents heap exhaustion from JWTs with crafted kid values.
const CACHE_MAX_SIZE = 256;

interface CachedKey {
  key: CryptoKey;
  fetchedAt: number;
}

const cache = new Map<string, CachedKey>();
/** Last-access timestamps for LRU eviction (same pattern as @shared/crypto). */
const lastAccess = new Map<string, number>();
/** Negative cache: cacheKey -> timestamp the negative result was recorded. */
const negativeCache = new Map<string, number>();
/** Single-flight: in-flight JWKS fetches keyed by jwksUrl. */
const inFlight = new Map<string, Promise<unknown[]>>();

/** S-M3: include jwksUrl in cache key to isolate keys by issuer. */
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

/**
 * Fetches the JWKS `keys` array for `jwksUrl`, coalescing concurrent callers
 * onto one in-flight request. Throws on network error / non-OK / malformed
 * JSON so the caller can distinguish "fetch failed" from "kid absent".
 */
async function fetchJwksKeys(jwksUrl: string): Promise<unknown[]> {
  const existing = inFlight.get(jwksUrl);
  if (existing) return existing;

  const promise = (async () => {
    const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: unknown[] };
    return Array.isArray(body.keys) ? body.keys : [];
  })();

  inFlight.set(jwksUrl, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(jwksUrl);
  }
}

/**
 * Resolves a CryptoKey for `kid` by fetching the JWKS. Returns `null` for any
 * failure (network error, non-OK, malformed JSON, unknown kid, bad JWK) and
 * records a negative-cache entry so repeated misses don't re-fetch.
 */
async function fetchPublicKey(kid: string, jwksUrl: string): Promise<CryptoKey | null> {
  let keys: unknown[];
  try {
    keys = await fetchJwksKeys(jwksUrl);
  } catch {
    negativeCache.set(cacheKey(kid, jwksUrl), Date.now());
    return null;
  }

  const jwk = keys.find(
    (k): k is Record<string, unknown> =>
      typeof k === "object" && k !== null && (k as Record<string, unknown>)["kid"] === kid,
  );

  if (!jwk) {
    negativeCache.set(cacheKey(kid, jwksUrl), Date.now());
    return null;
  }

  try {
    return await importKeyFromJwk(jwk);
  } catch {
    negativeCache.set(cacheKey(kid, jwksUrl), Date.now());
    return null;
  }
}

function storeInCache(ck: string, key: CryptoKey): void {
  if (cache.size >= CACHE_MAX_SIZE) evictLru();
  const now = Date.now();
  cache.set(ck, { key, fetchedAt: now });
  lastAccess.set(ck, now);
  negativeCache.delete(ck);
}

/** True if `ck` has a fresh negative-cache entry. */
function isNegativelyCached(ck: string): boolean {
  const at = negativeCache.get(ck);
  if (at === undefined) return false;
  if (Date.now() - at < NEGATIVE_TTL_MS) return true;
  negativeCache.delete(ck);
  return false;
}

/**
 * Returns the CryptoKey for `kid` from the cache or the JWKS endpoint.
 * Returns `null` if the key cannot be resolved (network error, unknown kid,
 * malformed JWK). Unknown kids are negative-cached for NEGATIVE_TTL_MS so a
 * flood of junk-`kid` tokens doesn't re-fetch upstream on every request.
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
    return cached.key;
  }

  if (isNegativelyCached(ck)) return null;

  const key = await fetchPublicKey(kid, jwksUrl);
  if (key) storeInCache(ck, key);
  return key;
}

/**
 * Bypasses both the positive and negative caches and re-fetches the JWKS
 * endpoint for `kid`. Call this when token verification fails against a cached
 * key — it may have been rotated. A genuine rotation must never be masked by a
 * stale negative entry, so this path ignores the negative cache. Updates the
 * cache on success.
 */
export async function refreshPublicKeyForKid(
  kid: string,
  jwksUrl: string,
): Promise<CryptoKey | null> {
  const ck = cacheKey(kid, jwksUrl);
  negativeCache.delete(ck);
  const key = await fetchPublicKey(kid, jwksUrl);
  if (key) storeInCache(ck, key);
  return key;
}

/** Clears the key cache (positive, negative, and in-flight). Tests only. */
export function clearJwksCache(): void {
  cache.clear();
  lastAccess.clear();
  negativeCache.clear();
  inFlight.clear();
}
