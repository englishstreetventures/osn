/**
 * The in-process coordination bundle: every store keeps its state in this
 * process's memory. Right for the Bun dev server, the OpenAPI generator and
 * tests, where there is one process; wrong for a Worker, where every isolate
 * would keep its own counters.
 */

import { createDefaultAccountErasureRateLimiters } from "../../routes/account-erasure";
import {
  createDefaultAuthRateLimiters,
  memoryLimiter,
  OSN_RATE_LIMITS,
} from "../../routes/auth/limiters";
import { createDefaultGraphRateLimiter } from "../../routes/graph";
import { createDefaultOrgRateLimiter } from "../../routes/organisation";
import { createDefaultProfileRateLimiters } from "../../routes/profile";
import { createDefaultRecommendationRateLimiters } from "../../routes/recommendations";
import {
  EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
  EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
  PROFILE_SWITCH_MAX,
  PROFILE_SWITCH_WINDOW_MS,
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
  TOTP_LOCKOUT_MS,
  TOTP_LOCKOUT_THRESHOLD,
} from "../../services/auth/constants";
import {
  createDefaultCeremonyStores,
  createInMemoryChallengeClaimStore,
  createInMemoryAccountCap,
  createInMemoryJtiStore,
} from "../../services/auth/stores";
import { createInMemoryRecoveryLockoutStore } from "../recovery-lockout-store";
import type { CoordinationStores } from "./index";
import { createCoordinationProbe, createMemoryProbeTarget } from "./probe";

/** A fresh in-memory bundle. It cannot fail, so it reports nothing. */
export function createInMemoryCoordination(): CoordinationStores {
  return {
    backend: "memory",
    authRateLimiters: createDefaultAuthRateLimiters(),
    graphRateLimiter: createDefaultGraphRateLimiter(),
    orgRateLimiter: createDefaultOrgRateLimiter(),
    profileRateLimiters: createDefaultProfileRateLimiters(),
    recommendationRateLimiters: createDefaultRecommendationRateLimiters(),
    accountExportLimiter: memoryLimiter(OSN_RATE_LIMITS.accountExport),
    accountExportIpLimiter: memoryLimiter(OSN_RATE_LIMITS.accountExportIp),
    accountErasureRateLimiters: createDefaultAccountErasureRateLimiters(),
    stepUpJtiStore: createInMemoryJtiStore(),
    passkeyChallengeClaims: createInMemoryChallengeClaimStore(),
    ceremonyStores: createDefaultCeremonyStores(),
    recoveryLockoutStore: createInMemoryRecoveryLockoutStore(),
    recoveryOtpLockoutStore: createInMemoryRecoveryLockoutStore(),
    totpLockoutStore: createInMemoryRecoveryLockoutStore({
      threshold: TOTP_LOCKOUT_THRESHOLD,
      lockoutMs: TOTP_LOCKOUT_MS,
    }),
    profileSwitchCap: createInMemoryAccountCap(PROFILE_SWITCH_MAX, PROFILE_SWITCH_WINDOW_MS),
    emailChangeBeginCap: createInMemoryAccountCap(
      EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
      EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
    ),
    recoveryEmailBeginCap: createInMemoryAccountCap(
      RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
      RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
    ),
    healthProbe: createCoordinationProbe(createMemoryProbeTarget()),
    healthProbeLimiter: memoryLimiter(OSN_RATE_LIMITS.healthCoordination),
  };
}
