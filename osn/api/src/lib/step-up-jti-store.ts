/**
 * Cluster-safe single-use guard for step-up token `jti` values.
 *
 * Backed by a single atomic Lua script so two pods cannot both accept the
 * same jti. Falls back to a no-op-allow on Redis errors ONLY if the caller
 * sets `failOpen: true` — by default we fail closed on Redis unavailability
 * because the whole point of the guard is that a leaked token must not
 * succeed twice.
 */

import type { RedisClient } from "@shared/redis";

import type { StepUpJtiStore } from "../services/auth";

/** Lua: return 1 iff this is the first time this jti has been consumed. */
const CONSUME_JTI_SCRIPT = `
if redis.call('GET', KEYS[1]) then
  return 0
else
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
  return 1
end
`;

export interface RedisJtiStoreConfig {
  /** Redis namespace prefix. Default: "stepup:jti". */
  namespace?: string;
  /**
   * If Redis is unreachable, fail closed (reject every step-up verification).
   * Default: true — the advertised single-use property must not degrade
   * silently into "Redis is down so everything is allowed".
   */
  failClosedOnError?: boolean;
}

/**
 * Redis-backed step-up jti store. Replaces the default in-memory map so the
 * single-use property holds across multi-pod deployments (S-H1).
 */
export function createRedisJtiStore(
  client: RedisClient,
  config: RedisJtiStoreConfig = {},
): StepUpJtiStore {
  const namespace = config.namespace ?? "stepup:jti";
  const failClosed = config.failClosedOnError ?? true;
  return {
    async consume(jti, ttlMs) {
      const key = `${namespace}:${jti}`;
      try {
        const result = await client.eval(CONSUME_JTI_SCRIPT, [key], [ttlMs]);
        return result === 1 || result === "1";
      } catch {
        // S-H1: fail closed by default — a Redis outage must not regress
        // single-use semantics. An unavailable replay guard is equivalent
        // to a ceremony no one actually completed.
        return !failClosed;
      }
    },
  };
}
