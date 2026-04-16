/**
 * Generic per-key fixed-window rate limiter for unauthenticated endpoints.
 *
 * Designed for auth routes where keying is by IP address (callers aren't
 * authenticated). The default in-memory backend stores state in-process —
 * resets on restart. See S-M2 for the migration-to-shared-counter note.
 *
 * The `RateLimiterBackend` interface is backend-agnostic so routes can be
 * wired to a future Redis backend without any call-site changes (Phase 2 of
 * the Redis migration plan in TODO.md). `check()` returns `boolean | Promise<boolean>`
 * so consumers `await` the result — sync backends resolve immediately, async
 * backends (Redis INCR+EXPIRE via Lua) return a real promise.
 */

/**
 * Backend-agnostic rate limiter contract. The in-memory implementation
 * (`createRateLimiter`) satisfies this sync-only; a future Redis backend
 * will satisfy it async. Route factories depend on this abstract type so
 * swapping backends is a single-import change at composition time.
 */
export interface RateLimiterBackend {
  /** Returns `true` if the request is allowed, `false` if rate-limited. */
  check(key: string): boolean | Promise<boolean>;
}

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

/** In-memory backend extension of `RateLimiterBackend`. `_store` is visible for testing. */
export interface RateLimiter extends RateLimiterBackend {
  check(key: string): boolean;
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
