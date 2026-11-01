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

export const RECOVERY_LOCKOUT_THRESHOLD = 5;
export const RECOVERY_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export type RecoveryLockoutBackend = "memory" | "durable_object";

/**
 * What a lockout check answers: `"locked"` while the account has at least the
 * threshold's failures inside the window, `"open"` otherwise, each with the
 * failures counted; `"unknown"` when the counter could not be read. A caller
 * that succeeds skips `reset` when `failures` was 0: there is nothing to clear.
 */
export type LockoutReading =
  | { readonly status: "open" | "locked"; readonly failures: number }
  | { readonly status: "unknown" };

export interface RecoveryLockoutStore {
  readonly backend: RecoveryLockoutBackend;
  /** The account's standing, and its failures inside the window. */
  status(accountId: string): Promise<LockoutReading>;
  /**
   * Record one failed attempt. Returns the running failure count within the
   * current window (so the caller can emit a `locked` metric on the attempt
   * that crosses the threshold), or `"unknown"` when it could not be recorded.
   * The TOTP check calls it for every attempt, before it compares the code,
   * and refuses unread any attempt whose count is over the threshold.
   */
  recordFailure(accountId: string): Promise<number | "unknown">;
  /**
   * Take back `failures` — the count this caller's `status` or `recordFailure`
   * answered — on a success, deleting the counter when none are left. A
   * failure recorded since stands, with the window it was counted in. Should
   * the window end between that read and this call, up to `failures` of the
   * next window's count go instead. Never rejects.
   */
  reset(accountId: string, failures: number): Promise<void>;
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
      const failures = live(accountId)?.count ?? 0;
      return { status: failures >= threshold ? "locked" : "open", failures };
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
    async reset(accountId, failures) {
      const bucket = live(accountId);
      if (!bucket) return;
      bucket.count -= failures;
      if (bucket.count <= 0) buckets.delete(accountId);
    },
  };
}
