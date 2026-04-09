/**
 * Generic per-key fixed-window rate limiter for unauthenticated endpoints.
 *
 * Designed for auth routes where keying is by IP address (callers aren't
 * authenticated). The store is in-process memory — resets on restart.
 * See S-M2 for the migration-to-shared-counter note.
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
  /** Visible for testing only. */
  readonly _store: Map<string, Entry>;
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const store = new Map<string, Entry>();
  const maxEntries = config.maxEntries ?? 10_000;
  let lastSweep = Date.now();

  /**
   * Evict expired entries. Runs on every check() call but short-circuits
   * if less than one window has elapsed since the last sweep (P-W16).
   * Also runs unconditionally when store exceeds maxEntries as a hard cap.
   */
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
 * Extract client IP from request headers. Prefers x-forwarded-for first
 * entry (reverse proxy); falls back to "unknown" when unavailable.
 */
export function getClientIp(headers: Record<string, string | undefined>): string {
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}
