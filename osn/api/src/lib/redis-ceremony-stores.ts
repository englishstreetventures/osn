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
  PendingRecoveryOtp,
  PendingRegistration,
  PendingTotpEnrollment,
  StepUpOtpEntry,
} from "../services/auth";
import {
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
  TOTP_LOCKOUT_MS,
  TOTP_LOCKOUT_THRESHOLD,
} from "../services/auth/constants";
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
  store: RedisNamespace | "recovery_lockout" | "totp_lockout" | "recovery_otp_lockout",
  op: string,
  cause: unknown,
) => void;

export interface RedisCeremonyWiring {
  ceremonyStores: CeremonyStores;
  recoveryLockoutStore: RecoveryLockoutStore;
  recoveryOtpLockoutStore: RecoveryLockoutStore;
  totpLockoutStore: RecoveryLockoutStore;
  profileSwitchCap: AccountCapLimiter;
  emailChangeBeginCap: AccountCapLimiter;
  recoveryEmailBeginCap: AccountCapLimiter;
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
    pendingRecoveryOtp: make<PendingRecoveryOtp>("pending_recovery_otp"),
    pendingTotpEnrollments: make<PendingTotpEnrollment>("pending_totp_enroll"),
    pendingEmailChanges: make<PendingEmailChange>("pending_email_change"),
    crossDeviceRequests: make<CrossDeviceRequest>("cross_device"),
    authorizeRequests: make<PendingAuthorizeRequest>("oidc_authorize_request"),
  };

  const recoveryLockoutStore = createRedisRecoveryLockoutStore(client, {
    onError: (op, cause) => onError?.("recovery_lockout", op, cause),
  });

  // The email-OTP recovery counter. Its own key prefix and fail-CLOSED, for the
  // reason TOTP's is: there is no wide search space behind a six-digit code, so
  // failing open removes the only effective defence rather than a redundant one.
  // Separate from `recoveryLockoutStore` so an attacker grinding 64-bit recovery
  // codes cannot deny the owner the email path, nor the reverse.
  const recoveryOtpLockoutStore = createRedisRecoveryLockoutStore(client, {
    keyPrefix: "osn:recovery-otp-lockout",
    failClosed: true,
    onError: (op, cause) => onError?.("recovery_otp_lockout", op, cause),
  });

  // The same counter shape, the OPPOSITE outage posture — see the fail-closed
  // rationale in `recovery-lockout-store.ts`. Its own key prefix, so a TOTP
  // failure never counts against a recovery-code attempt or vice versa.
  const totpLockoutStore = createRedisRecoveryLockoutStore(client, {
    keyPrefix: "osn:totp-lockout",
    threshold: TOTP_LOCKOUT_THRESHOLD,
    lockoutMs: TOTP_LOCKOUT_MS,
    failClosed: true,
    onError: (op, cause) => onError?.("totp_lockout", op, cause),
  });

  // The two per-account caps routed through the rate-limiter family. The
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
  // Keyed on the RESOLVED accountId by its one caller — never on the identifier
  // a stranger submitted. See `beginEmailRecovery`.
  const recoveryEmailBeginCap: AccountCapLimiter = createRedisRateLimiter(client, {
    namespace: "auth:recovery_email_begin_cap",
    maxRequests: RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
    windowMs: RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
  });

  return {
    ceremonyStores,
    recoveryLockoutStore,
    recoveryOtpLockoutStore,
    totpLockoutStore,
    profileSwitchCap,
    emailChangeBeginCap,
    recoveryEmailBeginCap,
  };
}
