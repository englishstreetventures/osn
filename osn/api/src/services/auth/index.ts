/**
 * Auth service — composition root.
 *
 * The service is a factory (`createAuthService`) that wires the domain
 * modules together over a shared {@link AuthContext} (resolved config +
 * injected stores) and returns the flat method surface the routes and
 * tests consume. Module layering (acyclic):
 *
 *   context → profiles → tokens ─┬→ registration / profile-switch / recovery
 *   sessions ─────────────────────┤
 *   step-up → security-events ────┴→ passkeys / passkey-management /
 *                                     email-change / cross-device
 *
 * Everything previously importable from `services/auth` is re-exported
 * below, so external import paths are unchanged.
 */

import type { AuthConfig } from "./config";
import { createAuthContext } from "./context";
import { createCrossDeviceModule } from "./cross-device";
import { createEmailChangeModule } from "./email-change";
import { hashSessionToken } from "./helpers";
import { createPasskeyManagementModule } from "./passkey-management";
import { createPasskeysModule } from "./passkeys";
import { createProfileSwitchModule } from "./profile-switch";
import { createProfilesModule } from "./profiles";
import { createRecoveryModule } from "./recovery";
import { createRegistrationModule } from "./registration";
import { createSecurityEventsModule } from "./security-events";
import { createSessionsModule } from "./sessions";
import { createStepUpModule } from "./step-up";
import { createTokensModule } from "./tokens";

export { AuthError, DatabaseError, ValidationError } from "./errors";
export type { AuthConfig } from "./config";
export type {
  AccountCapLimiter,
  CeremonyStores,
  ChallengeEntry,
  CrossDeviceRequest,
  PendingEmailChange,
  PendingRegistration,
  StepUpJtiStore,
  StepUpOtpEntry,
} from "./stores";
export { createInMemoryJtiStore } from "./stores";
export type {
  PasskeySummary,
  ProfileWithEmail,
  PublicProfile,
  SecurityEventSummary,
  SessionMeta,
  SessionSummary,
  TokenSet,
} from "./types";

export function createAuthService(config: AuthConfig) {
  const ctx = createAuthContext(config);

  const profiles = createProfilesModule();
  const tokens = createTokensModule(ctx, profiles);
  const sessions = createSessionsModule();
  const stepUp = createStepUpModule(ctx);
  const securityEvents = createSecurityEventsModule(ctx, stepUp);
  const registration = createRegistrationModule(ctx, profiles, tokens);
  const profileSwitch = createProfileSwitchModule(ctx, profiles, tokens);
  const passkeys = createPasskeysModule(ctx, profiles, tokens, sessions, stepUp, securityEvents);
  const passkeyManagement = createPasskeyManagementModule(ctx, sessions, securityEvents);
  const recovery = createRecoveryModule(ctx, profiles, tokens);
  const emailChange = createEmailChangeModule(ctx, stepUp);
  const crossDevice = createCrossDeviceModule(ctx, profiles, tokens, securityEvents);

  return {
    findProfileByEmail: profiles.findProfileByEmail,
    findProfileByHandle: profiles.findProfileByHandle,
    findProfileById: profiles.findProfileById,
    findProfileByIdIncludingTombstoned: profiles.findProfileByIdIncludingTombstoned,
    findAccountById: profiles.findAccountById,
    findDefaultProfile: profiles.findDefaultProfile,
    resolveIdentifier: profiles.resolveIdentifier,
    registerProfile: registration.registerProfile,
    beginRegistration: registration.beginRegistration,
    completeRegistration: registration.completeRegistration,
    checkHandle: registration.checkHandle,
    issueTokens: tokens.issueTokens,
    refreshTokens: tokens.refreshTokens,
    verifyRefreshToken: tokens.verifyRefreshToken,
    verifyAccessToken: tokens.verifyAccessToken,
    switchProfile: profileSwitch.switchProfile,
    listAccountProfiles: profileSwitch.listAccountProfiles,
    beginPasskeyRegistration: passkeys.beginPasskeyRegistration,
    completePasskeyRegistration: passkeys.completePasskeyRegistration,
    beginPasskeyLogin: passkeys.beginPasskeyLogin,
    completePasskeyLoginDirect: passkeys.completePasskeyLoginDirect,
    listPasskeys: passkeyManagement.listPasskeys,
    renamePasskey: passkeyManagement.renamePasskey,
    deletePasskey: passkeyManagement.deletePasskey,
    invalidateSession: sessions.invalidateSession,
    invalidateAccountSessions: sessions.invalidateAccountSessions,
    invalidateOtherAccountSessions: sessions.invalidateOtherAccountSessions,
    generateRecoveryCodesForAccount: recovery.generateRecoveryCodesForAccount,
    consumeRecoveryCode: recovery.consumeRecoveryCode,
    completeRecoveryLogin: recovery.completeRecoveryLogin,
    countActiveRecoveryCodes: recovery.countActiveRecoveryCodes,
    listUnacknowledgedSecurityEvents: securityEvents.listUnacknowledgedSecurityEvents,
    acknowledgeSecurityEvent: securityEvents.acknowledgeSecurityEvent,
    acknowledgeAllSecurityEvents: securityEvents.acknowledgeAllSecurityEvents,
    // Exposed so tests can pin the "account email missing" / "no mailer
    // configured" defensive branches; in production this is only invoked
    // internally by the generate/consume paths.
    notifyRecovery: recovery.notifyRecovery,
    notifyRecoveryByAccountId: recovery.notifyRecoveryByAccountId,
    // Exposed for the same reason: tests pin the shared helper's
    // missing-recipient branch and per-call-site template/kind wiring; in
    // production it is only invoked internally by the passkey add/remove
    // and cross-device-login flows.
    notifySecurityEventByAccountId: securityEvents.notifySecurityEventByAccountId,
    beginStepUpPasskey: stepUp.beginStepUpPasskey,
    completeStepUpPasskey: stepUp.completeStepUpPasskey,
    beginStepUpOtp: stepUp.beginStepUpOtp,
    completeStepUpOtp: stepUp.completeStepUpOtp,
    verifyStepUpForRecoveryGenerate: stepUp.verifyStepUpForRecoveryGenerate,
    verifyStepUpForPasskeyDelete: stepUp.verifyStepUpForPasskeyDelete,
    verifyStepUpForPasskeyRegister: stepUp.verifyStepUpForPasskeyRegister,
    verifyStepUpForAccountDelete: stepUp.verifyStepUpForAccountDelete,
    verifyStepUpForAccountExport: stepUp.verifyStepUpForAccountExport,
    verifyStepUpForExternalPurpose: stepUp.verifyStepUpForExternalPurpose,
    issueStepUpToken: stepUp.issueStepUpToken,
    listAccountSessions: sessions.listAccountSessions,
    revokeAccountSession: sessions.revokeAccountSession,
    revokeAllOtherAccountSessions: sessions.revokeAllOtherAccountSessions,
    beginEmailChange: emailChange.beginEmailChange,
    completeEmailChange: emailChange.completeEmailChange,
    beginCrossDeviceLogin: crossDevice.beginCrossDeviceLogin,
    getCrossDeviceLoginStatus: crossDevice.getCrossDeviceLoginStatus,
    approveCrossDeviceLogin: crossDevice.approveCrossDeviceLogin,
    rejectCrossDeviceLogin: crossDevice.rejectCrossDeviceLogin,
    hashSessionToken: (token: string) => hashSessionToken(token),
  };
}

// Type alias for the service
export type AuthService = ReturnType<typeof createAuthService>;
