/**
 * In-process JWKS public key cache for verifying OSN-issued user access tokens.
 *
 * Fetches the OSN API's JWKS endpoint on cache miss and caches resolved
 * CryptoKeys by `${jwksUrl}:${kid}` for JWKS_CACHE_TTL_MS, or for the time an
 * ARC lookup gives ({@link KeyLookup}). On verification failure against a
 * resolved key, the cache is bypassed once (refresh path) to handle key
 * rotation.
 *
 * Amplification defences:
 * - Negative cache: an unknown kid (or a fetch that fails) is remembered for
 *   NEGATIVE_TTL_MS so a flood of junk-`kid` tokens doesn't re-hit upstream on
 *   every request. A forced refresh bypasses the negative cache so a genuine
 *   rotation is never masked.
 * - Single-flight: concurrent fetches for the same jwksUrl share one in-flight
 *   promise instead of stampeding the issuer. An ARC lookup's fetches share
 *   one per cache key instead, in a map of their own, so no kid a sender
 *   names can join an access-token fetch.
 * - Fetch timeout: each JWKS fetch is bounded by JWKS_FETCH_TIMEOUT_MS so a
 *   hung upstream cannot pin the consumer.
 *
 * Bounded to CACHE_MAX_SIZE entries via LRU eviction — mirrors the
 * pattern in @shared/crypto/arc.ts (PR #63).
 * The cache key includes the JWKS URL so keys from different issuers never
 * collide even if kid values overlap.
 */

// Deep import from the DB-free `/jwk` entry, not the barrel: the barrel pulls
// arc.ts → @osn/db → bun:sqlite, which can't bundle for Cloudflare Workers
// (cire/api's organiser-auth middleware runs there). See @shared/crypto/jwk.
import { importKeyFromJwk } from "@shared/crypto/jwk";

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Negative-cache TTL for unknown kids and failed fetches, so junk kids cannot drive a fetch each. */
const NEGATIVE_TTL_MS = 30 * 1000; // 30 seconds
/** Upper bound on a single JWKS fetch so a hung upstream can't pin us. */
const JWKS_FETCH_TIMEOUT_MS = 5000;
// Realistic key-rotation scenarios will never exceed single digits;
// cap prevents heap exhaustion from JWTs with crafted kid values.
const CACHE_MAX_SIZE = 256;
// The negative cache MUST also be bounded. Unknown/junk kids each
// insert a distinct entry, so an unauthenticated flood of random-`kid` tokens
// would otherwise grow the map without limit (heap-exhaustion DoS). FIFO-evict
// the oldest entry once the cap is reached.
const NEGATIVE_CACHE_MAX_SIZE = 1024;
// Minimum spacing between forced JWKS refetches for the SAME
// kid. A valid-`kid`/bad-signature token forces a rotation refetch; because
// kids are public, an attacker could otherwise drive one upstream fetch per
// request. One forced refetch per kid per window is enough to pick up a genuine
// rotation while capping the amplification factor.
const FORCED_REFRESH_COOLDOWN_MS = NEGATIVE_TTL_MS;

interface CachedKey {
  key: CryptoKey;
  fetchedAt: number;
  /** How long after `fetchedAt` the key is used without asking again. */
  ttlMs: number;
}

/**
 * A JWKS entry, narrowed to the one member this cache reads: the `kid` it is
 * looked up by. The key material itself is never inspected here — the matched
 * entry goes to `importKeyFromJwk`, which validates the ES256 (EC P-256) shape
 * and rejects anything else.
 */
interface JwksEntry {
  readonly kid: string;
}

/**
 * Which published `kid` a lookup wants. Exact by default; an ARC lookup whose
 * kid carries a part the app could not verify names the entry by the part it
 * did verify (`@shared/crypto/arc-kid`, `checkArcKid`).
 */
export type KidNames = (publishedKid: string) => boolean;

/**
 * How an ARC lookup finds its key: which published kid it wants, the URL that
 * answers for that one key, and how long the key is kept. The lookup id is
 * what the key is cached under; `from` may carry parts of the kid the app did
 * not verify, so no fetch count and no cache entry depends on it.
 */
export interface KeyLookup {
  readonly names: KidNames;
  /** The URL to fetch: the JWKS URL, asking for one kid. */
  readonly from: string;
  /** How long the key is kept, from when its fetch started. */
  readonly ttlMs: number;
}

/** True when `value` is a JWKS entry published under a kid `names` accepts. */
function isNamedEntry(value: unknown, names: KidNames): value is JwksEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "kid" in value &&
    typeof value.kid === "string" &&
    names(value.kid)
  );
}

const cache = new Map<string, CachedKey>();
/** Last-access timestamps for LRU eviction (same pattern as @shared/crypto). */
const lastAccess = new Map<string, number>();
/** Negative cache: cacheKey -> timestamp the negative result was recorded. */
const negativeCache = new Map<string, number>();
/** Forced-refresh throttle: cacheKey -> timestamp of the last forced refetch. */
const lastForcedRefresh = new Map<string, number>();
/** Single-flight: in-flight JWKS fetches keyed by jwksUrl. */
const inFlight = new Map<string, Promise<unknown[]>>();
/** Single-flight for ARC lookups: in-flight fetches keyed by cache key, apart from `inFlight`. */
const lookupsInFlight = new Map<string, Promise<unknown[]>>();

/** Records a negative-cache entry, FIFO-evicting the oldest when at capacity. */
function recordNegative(ck: string): void {
  if (!negativeCache.has(ck) && negativeCache.size >= NEGATIVE_CACHE_MAX_SIZE) {
    const oldest = negativeCache.keys().next().value;
    if (oldest !== undefined) negativeCache.delete(oldest);
  }
  negativeCache.set(ck, Date.now());
}

/** Includes jwksUrl in the cache key, isolating keys by issuer. */
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
 * Fetches the JWKS `keys` array from `url`, coalescing concurrent callers that
 * share `flight` in `flights` onto one in-flight request. Throws on network
 * error / non-OK / malformed JSON so the caller can distinguish "fetch
 * failed" from "kid absent".
 */
async function fetchJwksKeys(
  url: string,
  flights: Map<string, Promise<unknown[]>> = inFlight,
  flight: string = url,
): Promise<unknown[]> {
  const existing = flights.get(flight);
  if (existing) return existing;

  const promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: unknown[] };
    return Array.isArray(body.keys) ? body.keys : [];
  })();

  flights.set(flight, promise);
  try {
    return await promise;
  } finally {
    flights.delete(flight);
  }
}

/**
 * Resolves a CryptoKey for `kid` by fetching the JWKS and taking the first
 * entry the lookup's `names` accepts (the exact kid without one). Returns
 * `null` for any failure (network error, non-OK, malformed JSON, unknown kid,
 * bad JWK) and records a negative-cache entry under `kid` so repeated misses
 * don't re-fetch.
 */
async function fetchPublicKey(
  kid: string,
  jwksUrl: string,
  lookup?: KeyLookup,
): Promise<CryptoKey | null> {
  const ck = cacheKey(kid, jwksUrl);
  const names: KidNames = lookup?.names ?? ((published) => published === kid);
  let keys: unknown[];
  try {
    keys = lookup
      ? await fetchJwksKeys(lookup.from, lookupsInFlight, ck)
      : await fetchJwksKeys(jwksUrl);
  } catch {
    recordNegative(ck);
    return null;
  }

  const jwk = keys.find((k): k is JwksEntry => isNamedEntry(k, names));

  if (!jwk) {
    recordNegative(ck);
    return null;
  }

  try {
    return await importKeyFromJwk(jwk);
  } catch {
    recordNegative(ck);
    return null;
  }
}

function storeInCache(
  ck: string,
  key: CryptoKey,
  ttlMs: number = JWKS_CACHE_TTL_MS,
  fetchedAt: number = Date.now(),
): void {
  if (cache.size >= CACHE_MAX_SIZE) evictLru();
  const now = Date.now();
  cache.set(ck, { key, fetchedAt, ttlMs });
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
 *
 * Both caches are keyed by `kid` as given. Without `lookup` the key is the
 * entry published under exactly `kid`, fetched from `jwksUrl` and kept
 * JWKS_CACHE_TTL_MS. An ARC lookup ({@link KeyLookup}) passes the part of the
 * kid it verified as `kid`, a `names` matching it, the URL that answers for
 * that key and how long to keep it.
 */
export async function resolvePublicKeyForKid(
  kid: string,
  jwksUrl: string,
  lookup?: KeyLookup,
): Promise<CryptoKey | null> {
  const ck = cacheKey(kid, jwksUrl);
  const now = Date.now();
  const cached = cache.get(ck);
  if (cached && now - cached.fetchedAt < cached.ttlMs) {
    lastAccess.set(ck, now);
    return cached.key;
  }

  if (isNegativelyCached(ck)) return null;

  // An ARC lookup's key is kept from when its fetch started, so its time
  // never runs past what osn-api's own hold allows for (`KeyLookup`).
  const startedAt = Date.now();
  const key = await fetchPublicKey(kid, jwksUrl, lookup);
  if (key) storeInCache(ck, key, lookup?.ttlMs, lookup ? startedAt : undefined);
  return key;
}

/**
 * Bypasses both the positive and negative caches and re-fetches the JWKS
 * endpoint for `kid`, matched exactly: never pass it an ARC lookup id, which
 * names no published kid by itself (ARC never refreshes). Call this when token verification fails against a cached
 * key — it may have been rotated. A genuine rotation must never be masked by a
 * stale negative entry, so this path ignores the negative cache. Updates the
 * cache on success.
 */
export async function refreshPublicKeyForKid(
  kid: string,
  jwksUrl: string,
): Promise<CryptoKey | null> {
  const ck = cacheKey(kid, jwksUrl);
  const now = Date.now();

  // Throttle forced refetches per kid. A valid-`kid`/bad-sig
  // token reaches here; without a throttle an attacker (kids are public) drives
  // one upstream JWKS fetch per request. If we forced a refetch for this kid
  // within the cooldown, skip the network call and return whatever is cached
  // (the caller re-verifies; a bad-sig token still fails). A genuine rotation is
  // still picked up by the first refetch in the window.
  const last = lastForcedRefresh.get(ck);
  if (last !== undefined && now - last < FORCED_REFRESH_COOLDOWN_MS) {
    const cached = cache.get(ck);
    return cached ? cached.key : null;
  }
  lastForcedRefresh.set(ck, now);

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
  lastForcedRefresh.clear();
  inFlight.clear();
  lookupsInFlight.clear();
}
