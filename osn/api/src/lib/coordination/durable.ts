/**
 * The coordination bundle on the `COORDINATION` Durable Object binding: every
 * store's state lives in `CoordinationStore` objects, one per key, so every
 * isolate of every Worker sees the same counters, ceremonies and claims.
 *
 * Each consumer interface maps onto the client in `@shared/coordination`:
 *
 * | Consumer | Call |
 * |---|---|
 * | rate limiters, per-account caps | `increment` in a fixed window; a failed call denies |
 * | ceremony `set` / `get` / `delete` / `consume` | `write` (JSON) / `read` / `remove` / `remove` |
 * | ceremony `recordAttempt` / `clearAttempts` | `increment` / `remove`, on `<store>-attempts` |
 * | step-up token guard | `claim` |
 * | lockout `status` / `recordFailure` / `reset` | `count` / `increment` / `remove` |
 *
 * Failure posture, per store:
 *
 * - A limiter or cap denies.
 * - A ceremony call rejects; its caller decides what the request answers.
 * - The step-up guard rejects, so a token whose single use cannot be checked
 *   is not accepted.
 * - A lockout answers `"unknown"` for `status` and `recordFailure`, which every
 *   caller refuses, and swallows a failed `reset` — the counter expires on its
 *   own.
 *
 * Every failed call reaches `onError` once, with the store's name and the
 * operation, never a key or a value. Nothing here logs on its own; every call
 * is counted on `osn.coordination.store.operations` ({@link measured}).
 */

import {
  createCoordinationClient,
  createCoordinationRateLimiter,
  type CoordinationClient,
  type CoordinationNamespace,
  type CoordinationOp,
  type CoordinationRateLimiter,
} from "@shared/coordination";
import type { RateLimiterBackend } from "@shared/rate-limit";

import { metricCeremonyStoreOp, metricCoordinationStoreOp } from "../../metrics";
import type { AccountErasureRateLimiters } from "../../routes/account-erasure";
import {
  AUTH_RATE_LIMITS,
  OSN_RATE_LIMITS,
  type AuthRateLimiters,
  type RateLimitBudget,
} from "../../routes/auth/limiters";
import { TOTP_LOCKOUT_MS, TOTP_LOCKOUT_THRESHOLD } from "../../services/auth/constants";
import type {
  CeremonyStores,
  ChallengeEntry,
  CrossDeviceRequest,
  PendingAuthorizeRequest,
  PendingEmailChange,
  PendingRecoveryOtp,
  PendingRegistration,
  PendingTotpEnrollment,
  RecoveryDisownToken,
  RegistrationChallengeEntry,
  StepUpJtiStore,
  StepUpOtpEntry,
} from "../../services/auth/stores";
import type { CeremonyStore } from "../ceremony-store";
import { RECOVERY_LOCKOUT_MS, RECOVERY_LOCKOUT_THRESHOLD } from "../recovery-lockout-store";
import type { RecoveryLockoutStore } from "../recovery-lockout-store";
import type { CoordinationErrorReporter, CoordinationStores } from "./index";
import type { CeremonyStoreName, CoordinationStoreName, LockoutStoreName } from "./names";

/**
 * `ns` as one store sees it: every call an object answers or fails is counted
 * on `osn.coordination.store.operations` under `store`, retries included. The
 * count carries the store's name, the operation and the outcome only.
 */
export function measured(
  ns: CoordinationNamespace,
  store: CoordinationStoreName,
): CoordinationNamespace {
  return {
    getByName(name) {
      const stub = ns.getByName(name);
      const count = <A>(op: CoordinationOp, run: () => Promise<A>): Promise<A> => {
        let pending: Promise<A>;
        try {
          pending = run();
        } catch (error) {
          metricCoordinationStoreOp({ store, op, result: "error" });
          throw error;
        }
        return pending.then(
          (value) => {
            metricCoordinationStoreOp({ store, op, result: "ok" });
            return value;
          },
          (error: unknown) => {
            metricCoordinationStoreOp({ store, op, result: "error" });
            throw error;
          },
        );
      };
      return {
        increment: (windowMs) => count("increment", () => stub.increment(windowMs)),
        count: () => count("count", () => stub.count()),
        read: () => count("read", () => stub.read()),
        write: (value, ttlMs) => count("write", () => stub.write(value, ttlMs)),
        remove: () => count("remove", () => stub.remove()),
        claim: (ttlMs) => count("claim", () => stub.claim(ttlMs)),
      };
    },
  };
}

/** A fixed-window limiter on its own store. Fails closed. */
function limiter(
  ns: CoordinationNamespace,
  store: CoordinationStoreName,
  budget: RateLimitBudget,
  onError: CoordinationErrorReporter,
): CoordinationRateLimiter {
  return createCoordinationRateLimiter(measured(ns, store), {
    namespace: store,
    maxRequests: budget.maxRequests,
    windowMs: budget.windowMs,
    onError,
  });
}

function client(
  ns: CoordinationNamespace,
  store: CoordinationStoreName,
  onError: CoordinationErrorReporter,
): CoordinationClient {
  return createCoordinationClient(measured(ns, store), { namespace: store, onError });
}

/**
 * A ceremony store whose entries are JSON in one object per key. A value that
 * does not parse reads as absent: this store is its only writer, so that is a
 * truncated or foreign entry, and "absent" sends the user back to `begin`.
 */
export function createDurableCeremonyStore<V>(
  ns: CoordinationNamespace,
  name: CeremonyStoreName,
  onError: CoordinationErrorReporter,
): CeremonyStore<V> {
  const store = client(ns, name, onError);
  // Guesses are counted on their own objects, so a `set` never resets a count.
  const guesses = client(ns, `${name}-attempts`, onError);
  const op = (kind: "set" | "get" | "delete") =>
    metricCeremonyStoreOp({ op: kind, namespace: name, backend: "durable_object" });
  return {
    backend: "durable_object",
    namespace: name,
    recordAttempt: (key, windowMs) => guesses.increment(key, windowMs),
    async clearAttempts(key) {
      await guesses.remove(key);
    },
    async set(key, value, ttlMs) {
      op("set");
      await store.write(key, JSON.stringify(value), ttlMs);
    },
    async get(key) {
      op("get");
      const raw = await store.read(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as V;
      } catch {
        return null;
      }
    },
    async delete(key) {
      op("delete");
      await store.remove(key);
    },
    async consume(key) {
      op("delete");
      return store.remove(key);
    },
  };
}

/** A per-account failed-attempt counter. See the module docstring for its failure posture. */
export function createDurableLockoutStore(
  ns: CoordinationNamespace,
  name: LockoutStoreName,
  config: { readonly threshold: number; readonly lockoutMs: number },
  onError: CoordinationErrorReporter,
): RecoveryLockoutStore {
  const store = client(ns, name, onError);
  return {
    backend: "durable_object",
    async status(accountId) {
      try {
        return (await store.count(accountId)) >= config.threshold ? "locked" : "open";
      } catch {
        return "unknown";
      }
    },
    async recordFailure(accountId) {
      try {
        return await store.increment(accountId, config.lockoutMs);
      } catch {
        return "unknown";
      }
    },
    async reset(accountId) {
      try {
        await store.remove(accountId);
      } catch {
        // Reported through `onError`; the counter expires with its window.
      }
    },
  };
}

/** The step-up token guard: the first `claim` of a token id wins. */
export function createDurableJtiStore(
  ns: CoordinationNamespace,
  onError: CoordinationErrorReporter,
): StepUpJtiStore {
  const store = client(ns, "step_up_jti", onError);
  return {
    consume: (jti, ttlMs) => store.claim(jti, ttlMs),
  };
}

/** Every store on the `COORDINATION` binding `ns`. */
export function createDurableCoordination(
  ns: CoordinationNamespace,
  onError: CoordinationErrorReporter,
): CoordinationStores {
  const named = (budget: RateLimitBudget & { readonly store: CoordinationStoreName }) =>
    limiter(ns, budget.store, budget, onError);

  const authRateLimiters = {} as { -readonly [K in keyof AuthRateLimiters]: RateLimiterBackend };
  for (const key of Object.keys(AUTH_RATE_LIMITS) as (keyof AuthRateLimiters)[]) {
    const budget = AUTH_RATE_LIMITS[key];
    authRateLimiters[key] = limiter(ns, `auth.${budget.ns}`, budget, onError);
  }

  const ceremony = <V>(name: CeremonyStoreName) => createDurableCeremonyStore<V>(ns, name, onError);
  const ceremonyStores: CeremonyStores = {
    registrationChallenges: ceremony<RegistrationChallengeEntry>("reg_challenge"),
    loginChallenges: ceremony<ChallengeEntry>("login_challenge"),
    pendingRegistrations: ceremony<PendingRegistration>("pending_registration"),
    stepUpPasskeyChallenges: ceremony<ChallengeEntry>("step_up_challenge"),
    stepUpOtp: ceremony<StepUpOtpEntry>("step_up_otp"),
    pendingRecoveryOtp: ceremony<PendingRecoveryOtp>("pending_recovery_otp"),
    pendingTotpEnrollments: ceremony<PendingTotpEnrollment>("pending_totp_enroll"),
    pendingEmailChanges: ceremony<PendingEmailChange>("pending_email_change"),
    crossDeviceRequests: ceremony<CrossDeviceRequest>("cross_device"),
    authorizeRequests: ceremony<PendingAuthorizeRequest>("oidc_authorize_request"),
    recoveryDisownTokens: ceremony<RecoveryDisownToken>("recovery_disown"),
  };

  const accountErasureRateLimiters: AccountErasureRateLimiters = {
    accountDelete: named(OSN_RATE_LIMITS.accountDelete),
    accountRestore: named(OSN_RATE_LIMITS.accountRestore),
    accountDeletionStatus: named(OSN_RATE_LIMITS.accountDeletionStatus),
  };

  const recoveryLockout = { threshold: RECOVERY_LOCKOUT_THRESHOLD, lockoutMs: RECOVERY_LOCKOUT_MS };

  return {
    backend: "durable_object",
    authRateLimiters,
    graphRateLimiter: named(OSN_RATE_LIMITS.graphWrite),
    orgRateLimiter: named(OSN_RATE_LIMITS.orgWrite),
    profileRateLimiters: {
      profileCreate: named(OSN_RATE_LIMITS.profileCreate),
      profileDelete: named(OSN_RATE_LIMITS.profileDelete),
      profileSetDefault: named(OSN_RATE_LIMITS.profileSetDefault),
    },
    recommendationRateLimiters: {
      suggest: named(OSN_RATE_LIMITS.recommendationSuggest),
      search: named(OSN_RATE_LIMITS.recommendationSearch),
    },
    accountExportLimiter: named(OSN_RATE_LIMITS.accountExport),
    accountExportIpLimiter: named(OSN_RATE_LIMITS.accountExportIp),
    accountErasureRateLimiters,
    stepUpJtiStore: createDurableJtiStore(ns, onError),
    ceremonyStores,
    recoveryLockoutStore: createDurableLockoutStore(
      ns,
      "recovery_lockout",
      recoveryLockout,
      onError,
    ),
    // The emailed recovery code's counter. Its own store, so grinding one
    // recovery factor never locks the owner out of the other.
    recoveryOtpLockoutStore: createDurableLockoutStore(
      ns,
      "recovery_otp_lockout",
      recoveryLockout,
      onError,
    ),
    totpLockoutStore: createDurableLockoutStore(
      ns,
      "totp_lockout",
      { threshold: TOTP_LOCKOUT_THRESHOLD, lockoutMs: TOTP_LOCKOUT_MS },
      onError,
    ),
    profileSwitchCap: named(OSN_RATE_LIMITS.profileSwitchCap),
    emailChangeBeginCap: named(OSN_RATE_LIMITS.emailChangeBeginCap),
    recoveryEmailBeginCap: named(OSN_RATE_LIMITS.recoveryEmailBeginCap),
  };
}
