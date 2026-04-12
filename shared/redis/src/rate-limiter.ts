import type { RedisClient } from "./client";

export interface RedisRateLimiterConfig {
  /** Key namespace — used in Redis key prefix: `rl:{namespace}:{key}`. */
  readonly namespace: string;
  /** Maximum requests per window. */
  readonly maxRequests: number;
  /** Window duration in milliseconds. */
  readonly windowMs: number;
}

/** Maximum length for a rate limiter key (S-M2). */
const MAX_KEY_LENGTH = 256;

/** Allowed characters in namespace — validated at construction time (S-M2). */
const NAMESPACE_RE = /^[a-zA-Z0-9_:.-]+$/;

/**
 * Fixed-window rate limiter Lua script — atomic INCR + PEXPIRE in a single
 * round-trip.
 *
 * KEYS[1] = rate limit key (e.g. `rl:auth:192.168.1.1`)
 * ARGV[1] = maxRequests
 * ARGV[2] = windowMs (PEXPIRE milliseconds)
 *
 * Returns 1 (allowed) or 0 (rate-limited).
 */
const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
if current <= tonumber(ARGV[1]) then
  return 1
end
return 0
`;

/**
 * Create a Redis-backed fixed-window rate limiter.
 *
 * Returns an object whose `check(key): Promise<boolean>` method is
 * structurally compatible with `RateLimiterBackend` from
 * `osn/core/src/lib/rate-limit.ts`. Fail-closed: if the Redis command
 * rejects, the request is denied (returns `false`) per S-M36 posture.
 *
 * Throws at construction time if `namespace` contains invalid characters
 * (S-M2). At check time, keys exceeding 256 bytes are denied.
 */
export function createRedisRateLimiter(
  client: RedisClient,
  config: RedisRateLimiterConfig,
): { check(key: string): Promise<boolean> } {
  const { namespace, maxRequests, windowMs } = config;

  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid rate limiter namespace: "${namespace}" — must match ${NAMESPACE_RE}`);
  }

  return {
    async check(key: string): Promise<boolean> {
      try {
        if (key.length > MAX_KEY_LENGTH) return false;
        const redisKey = `rl:${namespace}:${key}`;
        const result = await client.eval(RATE_LIMIT_SCRIPT, [redisKey], [maxRequests, windowMs]);
        return result === 1;
      } catch {
        // Fail-closed: deny on backend error (S-M36 posture)
        return false;
      }
    },
  };
}
