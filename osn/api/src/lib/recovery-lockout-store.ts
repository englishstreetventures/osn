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
 * The same store shape guards the email-OTP recovery path and TOTP, each with
 * its own counter.
 *
 * # A counter that cannot be reached
 *
 * Every consumer fails closed. When the backing store cannot be read or
 * written, `status` answers `"unknown"` and `recordFailure` answers
 * `"unknown"`; the caller refuses the attempt with its usual generic error and
 * writes no security event, because nothing is known to have crossed the
 * threshold. `reset` never rejects: a counter left behind expires on its own.
 *
 * A six-digit code has nothing behind its counter — three acceptable codes in a
 * million is even odds inside a few hundred thousand attempts — so failing open
 * there removes the only effective defence. Recovery codes have a 64-bit space
 * behind theirs, but an outage that also stops the code being checked costs the
 * owner one retry, which is cheaper than any window in which guesses go
 * uncounted.
 */

import { type RedisClient, registerMemoryCounterScript } from "@shared/redis";

export const RECOVERY_LOCKOUT_THRESHOLD = 5;
export const RECOVERY_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export type RecoveryLockoutBackend = "memory" | "durable_object" | "redis";

/** What a lockout check answers. `"unknown"`: the counter could not be read. */
export type LockoutStatus = "open" | "locked" | "unknown";

export interface RecoveryLockoutStore {
  readonly backend: RecoveryLockoutBackend;
  /** `"locked"` while the account has ≥ THRESHOLD failures inside the window. */
  status(accountId: string): Promise<LockoutStatus>;
  /**
   * Record one failed attempt. Returns the running failure count within the
   * current window (so the caller can emit a `locked` metric on the attempt
   * that crosses the threshold), or `"unknown"` when it could not be recorded.
   */
  recordFailure(accountId: string): Promise<number | "unknown">;
  /** Clear the counter — called on a successful consume. Never rejects. */
  reset(accountId: string): Promise<void>;
}

export interface RecoveryLockoutConfig {
  threshold?: number;
  lockoutMs?: number;
}

interface MemoryBucket {
  count: number;
  resetAt: number;
}

/** In-memory lockout store — single-process dev/test. It cannot fail. */
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
    async status(accountId) {
      const bucket = live(accountId);
      return bucket !== null && bucket.count >= threshold ? "locked" : "open";
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

// Let the in-memory RedisClient (dev/test) emulate this counter script. No-op
// against real Redis, which executes the actual Lua. (X5 otherwise rejects any
// script it doesn't recognise.)
registerMemoryCounterScript(RECORD_FAILURE_SCRIPT);

export interface RedisRecoveryLockoutConfig extends RecoveryLockoutConfig {
  /** Key namespace prefix. Default: "osn:recovery-lockout". */
  keyPrefix?: string;
  /** Caught command error. */
  onError?: (op: "is_locked" | "record" | "reset", cause: unknown) => void;
}

/**
 * Redis-backed lockout store. One counter key per account with native PX
 * expiry. A command error answers `"unknown"` (see the module docstring).
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
    async status(accountId) {
      try {
        const raw = await client.get(key(accountId));
        if (raw === null) return "open";
        return Number(raw) >= threshold ? "locked" : "open";
      } catch (cause) {
        safeError("is_locked", cause);
        return "unknown";
      }
    },
    async recordFailure(accountId) {
      try {
        const result = await client.eval(RECORD_FAILURE_SCRIPT, [key(accountId)], [lockoutMs]);
        return Number(result);
      } catch (cause) {
        safeError("record", cause);
        return "unknown";
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
