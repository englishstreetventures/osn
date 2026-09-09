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
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
  RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
  TOTP_LOCKOUT_MS,
  TOTP_LOCKOUT_THRESHOLD,
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
  // The four step-up AMR allow-lists, in one place. TOTP joins the two sets
  // that already accept an emailed OTP; it joins neither
  // `passkeyDeleteAllowedAmr` nor `emailChangeAllowedAmr` — see
  // `[[wiki/systems/step-up]]` for the whole table and the reasoning.
  const recoveryGenerateAllowedAmr = new Set<string>(
    config.recoveryGenerateAllowedAmr ?? ["webauthn", "otp", "totp"],
  );
  const passkeyDeleteAllowedAmr = new Set<string>(config.passkeyDeleteAllowedAmr ?? ["webauthn"]);
  const passkeyRegisterAllowedAmr = new Set<string>(
    config.passkeyRegisterAllowedAmr ?? ["webauthn", "otp", "totp"],
  );
  // `/account/email/complete`. The one allow-list with no `AuthConfig` field:
  // its `otp` arm proves control of the CURRENT mailbox, which a TOTP seed does
  // not, and email change is the pivot to permanent takeover — so it is not a
  // deployment's choice to widen. Fixed here rather than inline at the verifier
  // so all four sets are read in one place.
  //
  // Two things this list cannot express, both handled by the provenance rule in
  // `step-up.ts`: a passkey registered minutes ago under a weaker factor mints
  // the `webauthn` it admits, and after an account recovery the `otp` arm's
  // premise — that the mailbox is the owner's — is the very thing in doubt.
  const emailChangeAllowedAmr = new Set<string>(["webauthn", "otp"]);
  const jtiStore = config.stepUpJtiStore ?? createInMemoryJtiStore();
  const rotatedSessionStore = config.rotatedSessionStore ?? createInMemoryRotatedSessionStore();
  const rotatedSessionStoreBackend = rotatedSessionStore.backend;

  // Ceremony / pending-state stores. Default to per-service in-memory;
  // index.ts injects Redis-backed equivalents in multi-pod deployments.
  const stores = config.ceremonyStores ?? createDefaultCeremonyStores();
  // Per-account caps routed through the rate-limiter family.
  const profileSwitchCap =
    config.profileSwitchCap ??
    createInMemoryAccountCap(PROFILE_SWITCH_MAX, PROFILE_SWITCH_WINDOW_MS);
  const emailChangeBeginCap =
    config.emailChangeBeginCap ??
    createInMemoryAccountCap(
      EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
      EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
    );
  const recoveryEmailBeginCap =
    config.recoveryEmailBeginCap ??
    createInMemoryAccountCap(
      RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX,
      RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS,
    );
  // Per-account recovery-code lockout counter.
  const recoveryLockoutStore = config.recoveryLockoutStore ?? createInMemoryRecoveryLockoutStore();
  // Per-account lockout for the email-OTP recovery path. Its own counter, and
  // fail-closed like the TOTP one: both guard a 6-digit code, where failing
  // open removes the only effective brake rather than a redundant one.
  const recoveryOtpLockoutStore =
    config.recoveryOtpLockoutStore ?? createInMemoryRecoveryLockoutStore();
  // Per-account TOTP lockout. The in-memory default cannot fail, so the
  // fail-closed posture only bites on the injected Redis-backed store.
  const totpLockoutStore =
    config.totpLockoutStore ??
    createInMemoryRecoveryLockoutStore({
      threshold: TOTP_LOCKOUT_THRESHOLD,
      lockoutMs: TOTP_LOCKOUT_MS,
    });
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
    emailChangeAllowedAmr,
    jtiStore,
    rotatedSessionStore,
    rotatedSessionStoreBackend,
    stores,
    profileSwitchCap,
    emailChangeBeginCap,
    recoveryEmailBeginCap,
    recoveryLockoutStore,
    recoveryOtpLockoutStore,
    totpLockoutStore,
    hashIp,
  };
}

export type AuthContext = ReturnType<typeof createAuthContext>;
