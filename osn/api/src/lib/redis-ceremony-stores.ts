/**
 * Redis-backed wiring for the O3 ceremony / pending-state stores, the O2
 * recovery-code lockout counter, and the two per-account caps.
 *
 * Mirrors `createRedisAuthRateLimiters` — one factory that takes a shared
 * `RedisClient` (+ an `onError` hook routed to the Effect logger at the
 * composition root) and returns the fully-built `CeremonyStores` bundle plus
 * the lockout store and cap limiters, ready to drop into `AuthConfig`.
 *
 * Each store carries the metric observer so per-namespace op/entry telemetry is
 * emitted identically to the in-memory default path.
 */

import { createRedisRateLimiter } from "@shared/redis";
import type { RedisClient, RedisNamespace } from "@shared/redis";

import { metricCeremonyStoreEntryDelta, metricCeremonyStoreOp } from "../metrics";
import type {
  AccountCapLimiter,
  CeremonyStores,
  ChallengeEntry,
  CrossDeviceRequest,
  PendingAuthorizeRequest,
  PendingEmailChange,
  PendingRegistration,
  StepUpOtpEntry,
} from "../services/auth";
import {
  createRedisCeremonyStore,
  type CeremonyStore,
  type CeremonyStoreObserver,
} from "./ceremony-store";
import {
  createRedisRecoveryLockoutStore,
  type RecoveryLockoutStore,
} from "./recovery-lockout-store";

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Caller hook for a caught Redis error inside any of these stores. */
export type CeremonyStoreErrorHook = (
  store: RedisNamespace | "recovery_lockout",
  op: string,
  cause: unknown,
) => void;

export interface RedisCeremonyWiring {
  ceremonyStores: CeremonyStores;
  recoveryLockoutStore: RecoveryLockoutStore;
  profileSwitchCap: AccountCapLimiter;
  emailChangeBeginCap: AccountCapLimiter;
}

export function createRedisCeremonyStores(
  client: RedisClient,
  onError?: CeremonyStoreErrorHook,
): RedisCeremonyWiring {
  const observerFor = (namespace: RedisNamespace): CeremonyStoreObserver => ({
    onOp: (op, ns) => metricCeremonyStoreOp({ op, namespace: ns, backend: "redis" }),
    onEntryDelta: (delta, ns) =>
      metricCeremonyStoreEntryDelta(delta, { namespace: ns, backend: "redis" }),
    onError: (op, cause) => onError?.(namespace, op, cause),
  });

  const make = <V>(namespace: RedisNamespace): CeremonyStore<V> =>
    createRedisCeremonyStore<V>(client, namespace, { observer: observerFor(namespace) });

  const ceremonyStores: CeremonyStores = {
    registrationChallenges: make<ChallengeEntry>("reg_challenge"),
    loginChallenges: make<ChallengeEntry>("login_challenge"),
    pendingRegistrations: make<PendingRegistration>("pending_registration"),
    stepUpPasskeyChallenges: make<ChallengeEntry>("step_up_challenge"),
    stepUpOtp: make<StepUpOtpEntry>("step_up_otp"),
    pendingEmailChanges: make<PendingEmailChange>("pending_email_change"),
    crossDeviceRequests: make<CrossDeviceRequest>("cross_device"),
    authorizeRequests: make<PendingAuthorizeRequest>("oidc_authorize_request"),
  };

  const recoveryLockoutStore = createRedisRecoveryLockoutStore(client, {
    onError: (op, cause) => onError?.("recovery_lockout", op, cause),
  });

  // O3: the two per-account caps routed through the rate-limiter family. The
  // limiter `check(accountId)` returns `true` while under the cap.
  const profileSwitchCap: AccountCapLimiter = createRedisRateLimiter(client, {
    namespace: "auth:profile_switch_cap",
    maxRequests: 20,
    windowMs: ONE_HOUR_MS,
  });
  const emailChangeBeginCap: AccountCapLimiter = createRedisRateLimiter(client, {
    namespace: "auth:email_change_begin_cap",
    maxRequests: 3,
    windowMs: ONE_DAY_MS,
  });

  return { ceremonyStores, recoveryLockoutStore, profileSwitchCap, emailChangeBeginCap };
}
