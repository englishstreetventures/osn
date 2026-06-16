/**
 * Per-account recovery-code failed-attempt lockout (O2).
 *
 * `consumeRecoveryCode` is the takeover step in the "attacker burns the user's
 * codes" threat model. Without a lockout, an online attacker who has resolved a
 * victim's identifier can grind the 64-bit code space at whatever rate the
 * per-IP limiter allows across a botnet. This store adds a per-account ceiling:
 * after `THRESHOLD` (5) failed attempts the account is locked for
 * `LOCKOUT_MS` (15 min), regardless of which IP the guesses came from.
 *
 * Crucial design point: the counter is keyed on the RESOLVED `accountId`, never
 * the caller-supplied identifier. Keying on the identifier would let an attacker
 * lock a victim out by spamming failures against the victim's handle — a denial
 * of service and, worse, an enumeration oracle ("this identifier can be
 * locked, therefore it exists"). Keying on the resolved account means only
 * genuine attempts against a real account move the counter, and an unknown
 * identifier (which resolves to no account) can never trip a lockout.
 *
 * On lockout the caller returns the SAME generic error as any other failure,
 * preserving the no-enumeration-oracle property.
 *
 * The store follows the injectable triple-pattern used elsewhere in the auth
 * service. The Redis backend uses an atomic INCR + PEXPIRE Lua script (the same
 * primitive as the rate-limiter family) so the count and the window are
 * consistent across pods. Fail-open posture: a Redis outage must not lock every
 * account out (that would be a self-inflicted DoS), so `isLocked` returns
 * `false` and `recordFailure` returns 0 on error. The trade-off is that the
 * lockout is temporarily ineffective during an outage — acceptable, because the
 * per-IP limiter and the 64-bit search space remain in force.
 */

import type { RedisClient } from "@shared/redis";

export const RECOVERY_LOCKOUT_THRESHOLD = 5;
export const RECOVERY_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export type RecoveryLockoutBackend = "memory" | "redis";

export interface RecoveryLockoutStore {
  readonly backend: RecoveryLockoutBackend;
  /** True if the account currently has ≥ THRESHOLD failures inside the window. */
  isLocked(accountId: string): Promise<boolean>;
  /**
   * Record one failed attempt. Returns the running failure count within the
   * current window (so the caller can emit a `locked` metric on the attempt
   * that crosses the threshold).
   */
  recordFailure(accountId: string): Promise<number>;
  /** Clear the counter — called on a successful consume. */
  reset(accountId: string): Promise<void>;
}

export interface RecoveryLockoutConfig {
  threshold?: number;
  lockoutMs?: number;
  /** Redis backend only — caught command error. */
  onError?: (op: "is_locked" | "record" | "reset", cause: unknown) => void;
}

interface MemoryBucket {
  count: number;
  resetAt: number;
}

/** In-memory lockout store — single-process dev/test. */
export function createInMemoryRecoveryLockoutStore(
  config: RecoveryLockoutConfig = {},
): RecoveryLockoutStore {
  const threshold = config.threshold ?? RECOVERY_LOCKOUT_THRESHOLD;
  const lockoutMs = config.lockoutMs ?? RECOVERY_LOCKOUT_MS;
  const buckets = new Map<string, MemoryBucket>();

  const live = (accountId: string): MemoryBucket | null => {
    const bucket = buckets.get(accountId);
    if (!bucket) return null;
    if (Date.now() >= bucket.resetAt) {
      buckets.delete(accountId);
      return null;
    }
    return bucket;
  };

  return {
    backend: "memory",
    async isLocked(accountId) {
      const bucket = live(accountId);
      return bucket !== null && bucket.count >= threshold;
    },
    async recordFailure(accountId) {
      const bucket = live(accountId);
      if (!bucket) {
        buckets.set(accountId, { count: 1, resetAt: Date.now() + lockoutMs });
        return 1;
      }
      bucket.count += 1;
      return bucket.count;
    },
    async reset(accountId) {
      buckets.delete(accountId);
    },
  };
}

/** Lua: INCR the key, set PEXPIRE only on first increment, return new count. */
const RECORD_FAILURE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export interface RedisRecoveryLockoutConfig extends RecoveryLockoutConfig {
  /** Key namespace prefix. Default: "osn:recovery-lockout". */
  keyPrefix?: string;
}

/**
 * Redis-backed lockout store. One counter key per account with native PX
 * expiry. Fail-open on Redis error (see module docstring).
 */
export function createRedisRecoveryLockoutStore(
  client: RedisClient,
  config: RedisRecoveryLockoutConfig = {},
): RecoveryLockoutStore {
  const threshold = config.threshold ?? RECOVERY_LOCKOUT_THRESHOLD;
  const lockoutMs = config.lockoutMs ?? RECOVERY_LOCKOUT_MS;
  const prefix = config.keyPrefix ?? "osn:recovery-lockout";
  const onError = config.onError;

  const key = (accountId: string): string => `${prefix}:${accountId}`;
  const safeError = (op: "is_locked" | "record" | "reset", cause: unknown): void => {
    try {
      onError?.(op, cause);
    } catch {
      /* swallowed */
    }
  };

  return {
    backend: "redis",
    async isLocked(accountId) {
      try {
        const raw = await client.get(key(accountId));
        if (raw === null) return false;
        return Number(raw) >= threshold;
      } catch (cause) {
        // Fail-open: an outage must not lock everyone out.
        safeError("is_locked", cause);
        return false;
      }
    },
    async recordFailure(accountId) {
      try {
        const result = await client.eval(RECORD_FAILURE_SCRIPT, [key(accountId)], [lockoutMs]);
        return Number(result);
      } catch (cause) {
        safeError("record", cause);
        return 0;
      }
    },
    async reset(accountId) {
      try {
        await client.del(key(accountId));
      } catch (cause) {
        safeError("reset", cause);
      }
    },
  };
}
