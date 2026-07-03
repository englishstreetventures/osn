/**
 * Shared per-service context: config with defaults resolved, the injected
 * (or default in-memory) stores, and the IP-hashing helper. Built once by
 * `createAuthService` and threaded through every domain module factory.
 */

import { createHmac } from "node:crypto";

import { createInMemoryRecoveryLockoutStore } from "../../lib/recovery-lockout-store";
import { createInMemoryRotatedSessionStore } from "../../lib/rotated-session-store";
import type { AuthConfig } from "./config";
import {
  EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
  EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
  PROFILE_SWITCH_MAX,
  PROFILE_SWITCH_WINDOW_MS,
} from "./constants";
import {
  createDefaultCeremonyStores,
  createInMemoryAccountCap,
  createInMemoryJtiStore,
} from "./stores";

export function createAuthContext(config: AuthConfig) {
  const accessTokenTtl = config.accessTokenTtl ?? 300;
  const refreshTokenTtl = config.refreshTokenTtl ?? 2592000;
  const otpTtl = config.otpTtl ?? 600;
  const stepUpTokenTtl = config.stepUpTokenTtl ?? 300;
  const recoveryGenerateAllowedAmr = new Set<string>(
    config.recoveryGenerateAllowedAmr ?? ["webauthn", "otp"],
  );
  const passkeyDeleteAllowedAmr = new Set<string>(config.passkeyDeleteAllowedAmr ?? ["webauthn"]);
  const passkeyRegisterAllowedAmr = new Set<string>(
    config.passkeyRegisterAllowedAmr ?? ["webauthn", "otp"],
  );
  const jtiStore = config.stepUpJtiStore ?? createInMemoryJtiStore();
  const rotatedSessionStore = config.rotatedSessionStore ?? createInMemoryRotatedSessionStore();
  const rotatedSessionStoreBackend = rotatedSessionStore.backend;

  // O3: ceremony / pending-state stores. Default to per-service in-memory;
  // index.ts injects Redis-backed equivalents in multi-pod deployments.
  const stores = config.ceremonyStores ?? createDefaultCeremonyStores();
  // O3: per-account caps routed through the rate-limiter family.
  const profileSwitchCap =
    config.profileSwitchCap ??
    createInMemoryAccountCap(PROFILE_SWITCH_MAX, PROFILE_SWITCH_WINDOW_MS);
  const emailChangeBeginCap =
    config.emailChangeBeginCap ??
    createInMemoryAccountCap(
      EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
      EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
    );
  // O2: per-account recovery-code lockout counter.
  const recoveryLockoutStore = config.recoveryLockoutStore ?? createInMemoryRecoveryLockoutStore();
  /**
   * HMAC-SHA256 pepper for IP hashing. Only applied when the caller has
   * configured one — in dev we leave ip_hash NULL so local Docker IPs
   * don't turn into stable "same device" signals by accident.
   */
  const hashIp = (ip: string): string | null => {
    const pepper = config.sessionIpPepper;
    if (!pepper) return null;
    return createHmac("sha256", pepper).update(ip).digest("hex");
  };

  return {
    config,
    accessTokenTtl,
    refreshTokenTtl,
    otpTtl,
    stepUpTokenTtl,
    recoveryGenerateAllowedAmr,
    passkeyDeleteAllowedAmr,
    passkeyRegisterAllowedAmr,
    jtiStore,
    rotatedSessionStore,
    rotatedSessionStoreBackend,
    stores,
    profileSwitchCap,
    emailChangeBeginCap,
    recoveryLockoutStore,
    hashIp,
  };
}

export type AuthContext = ReturnType<typeof createAuthContext>;
