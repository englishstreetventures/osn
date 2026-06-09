/**
 * Per-key fixed-window rate limiter for unauthenticated endpoints.
 *
 * In-memory store — resets on worker restart. Fine for a wedding site
 * where Workers instances are short-lived.
 *
 * Pattern adapted from OSN shared/rate-limit.
 */

export interface RateLimiterConfig {
  /** Maximum requests allowed per window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Maximum map entries before expired-entry sweep (default: 10_000). */
  maxEntries?: number;
}

interface Entry {
  count: number;
  windowStart: number;
}

export interface RateLimiter {
  /** Returns `true` if the request is allowed, `false` if rate-limited. */
  check(key: string): boolean;
  /** Exposed for testing. */
  readonly _store: Map<string, Entry>;
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const store = new Map<string, Entry>();
  const maxEntries = config.maxEntries ?? 10_000;
  let lastSweep = Date.now();

  function sweep() {
    const now = Date.now();
    if (store.size <= maxEntries && now - lastSweep < config.windowMs) return;
    lastSweep = now;
    for (const [key, entry] of store) {
      if (now - entry.windowStart > config.windowMs) store.delete(key);
    }
  }

  function check(key: string): boolean {
    sweep();
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || now - entry.windowStart > config.windowMs) {
      store.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= config.maxRequests) return false;
    entry.count++;
    return true;
  }

  return { check, _store: store };
}

/**
 * Extract client IP from request headers. Prefers cf-connecting-ip
 * (Cloudflare-specific), then x-forwarded-for first entry, falls back
 * to "unknown".
 */
export function getClientIp(headers: Headers): string {
  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();

  return "unknown";
}
