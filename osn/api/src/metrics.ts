/**
 * OSN Core domain metrics.
 *
 * Single source of truth — every counter/histogram for auth + social graph
 * lives here. Handlers and services use the `with*` helper wrappers below,
 * which attach a span AND record the result in one call.
 *
 * See `CLAUDE.md` "Observability" section for the full rules.
 */

import type { CoordinationOp } from "@shared/coordination";
import {
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
  RESULT_VALUES,
} from "@shared/observability/metrics";
import type {
  AppEnrollmentApp,
  AuthMethod,
  AuthRateLimitedEndpoint,
  CrossDeviceStep,
  DeletionCompletedResult,
  DeletionCompletedSource,
  DeletionFanoutResult,
  DeletionFanoutService,
  DeletionPhase,
  DeletionRequestResult,
  EmailChangeStep,
  EmailLinkConfirmOutcome,
  EmailLinkFlow,
  EmailLinkSendResult,
  EmailVerificationTokenOutcome,
  GraphBlockAction,
  GraphConnectionAction,
  OidcAuthorizeResult,
  OidcClientKind,
  OidcTokenResult,
  OrgAction,
  OrgMemberAction,
  OriginGuardRejectionReason,
  PasskeyAction,
  ProfileCrudAction,
  ProfileSwitchAction,
  RecoveryCodeConsumeResult,
  RecoveryCodeStep,
  RecoveryCooldownOutcome,
  RecoveryDisownResult,
  RecoveryPasskeyReclaimResult,
  RegisterStep,
  Result,
  SecurityEventKind,
  SecurityEventNotifyResult,
  SecurityInvalidationTrigger,
  SessionAction,
  StepUpFactor,
  StepUpStep,
  TotpOp,
  TotpVerifyResult,
  TotpRekeyResult,
  StepUpVerifyResult,
} from "@shared/observability/metrics";
import { Effect } from "effect";

import type { CeremonyStoreName, CoordinationStoreName } from "./lib/coordination/names";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const OSN_METRICS = {
  authOriginGuardRejections: "osn.auth.origin_guard.rejections",
  authJwksServed: "osn.auth.jwks.served",
  authRegisterAttempts: "osn.auth.register.attempts",
  authRegisterDuration: "osn.auth.register.duration",
  authLoginAttempts: "osn.auth.login.attempts",
  authLoginDuration: "osn.auth.login.duration",
  authTokenRefresh: "osn.auth.token.refresh",
  authHandleCheck: "osn.auth.handle.check",
  authRateLimited: "osn.auth.rate_limited",
  authTurnstileRejected: "osn.auth.turnstile.rejected",
  authSessionRotations: "osn.auth.session.rotations",
  authSessionReuseDetected: "osn.auth.session.reuse_detected",
  authSessionRotationRace: "osn.auth.session.rotation_race",
  authSessionFamilyRevoked: "osn.auth.session.family_revoked",
  authCeremonyStoreOps: "osn.auth.ceremony_store.operations",
  coordinationStoreOps: "osn.coordination.store.operations",
  retentionRowsDeleted: "osn.retention.rows_deleted",
  retentionCycleDuration: "osn.retention.cycle.duration",
  authSessionSecurityInvalidation: "osn.auth.session.security_invalidation",
  authSessionStaleRefused: "osn.auth.session.stale_refused",
  authCireSessionRevocations: "osn.auth.cire_session.revocations",
  authRecoveryLockout: "osn.auth.recovery.lockout",
  authStepUpLockout: "osn.auth.step_up.lockout",
  authRecoveryEmailBegin: "osn.auth.recovery.email_begin",
  authRecoveryCooldown: "osn.auth.recovery.cooldown",
  authRecoveryDisown: "osn.auth.recovery.disown",
  authRecoveryPasskeyReclaim: "osn.auth.recovery.passkey_reclaim",
  authRecoveryCodesGenerated: "osn.auth.recovery.codes_generated",
  authRecoveryCodeConsumed: "osn.auth.recovery.code_consumed",
  authRecoveryDuration: "osn.auth.recovery.duration",
  authStepUpIssued: "osn.auth.step_up.issued",
  authTotpOps: "osn.auth.totp.operations",
  authTotpDuration: "osn.auth.totp.duration",
  authTotpVerified: "osn.auth.totp.verified",
  authTotpLockout: "osn.auth.totp.lockout",
  authTotpRekeyed: "osn.auth.totp.rekeyed",
  authStepUpVerified: "osn.auth.step_up.verified",
  authSessionOps: "osn.auth.session.operations",
  authEmailChangeAttempts: "osn.auth.account.email_change.attempts",
  authEmailChangeDuration: "osn.auth.account.email_change.duration",
  authSecurityEventRecorded: "osn.auth.security_event.recorded",
  authSecurityEventNotified: "osn.auth.security_event.notified",
  authSecurityEventAcknowledged: "osn.auth.security_event.acknowledged",
  authSecurityEventNotifyDuration: "osn.auth.security_event.notify.duration",
  authPasskeyOps: "osn.auth.passkey.operations",
  authPasskeyDuration: "osn.auth.passkey.duration",
  authPasskeyLoginDiscoverable: "osn.auth.passkey.login_discoverable",
  authCrossDeviceAttempts: "osn.auth.cross_device.attempts",
  authCrossDeviceDuration: "osn.auth.cross_device.duration",
  authEmailLinkConfirmations: "osn.auth.email_link.confirmations",
  authEmailLinkSends: "osn.auth.email_link.sends",
  authEmailVerificationTokens: "osn.auth.email_verification.tokens",
  graphConnectionOps: "osn.graph.connection.operations",
  graphBlockOps: "osn.graph.block.operations",
  orgOps: "osn.org.operations",
  orgMemberOps: "osn.org.member.operations",
  profileSwitchAttempts: "osn.auth.profile_switch.attempts",
  profileCrudOps: "osn.profile.crud.operations",
  profileCrudDuration: "osn.profile.crud.duration",
  // Account data export (DSAR Art. 15 / 20)
  accountExportRequested: "osn.account.export.requested",
  // Account deletion (Flow A)
  accountDeletionRequested: "osn.account.deletion.requested",
  accountDeletionCompleted: "osn.account.deletion.completed",
  accountDeletionDuration: "osn.account.deletion.duration",
  accountDeletionFanout: "osn.account.deletion.fanout",
  accountDeletionFanoutPendingAge: "osn.account.deletion.fanout_pending_age",
  // App enrollments
  appEnrollmentJoined: "osn.account.app_enrollment.joined",
  appEnrollmentLeft: "osn.account.app_enrollment.left",
  // OIDC provider
  oidcAuthorize: "osn.oidc.authorize",
  oidcToken: "osn.oidc.token",
  oidcConsentGranted: "osn.oidc.consent.granted",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes
// ---------------------------------------------------------------------------

type RegisterAttrs = { step: RegisterStep; result: Result };
type LoginAttrs = { method: AuthMethod; result: Result };
type TokenRefreshAttrs = { result: Result };
type HandleCheckAttrs = { result: "available" | "taken" | "invalid" };
type EmailLinkConfirmAttrs = { outcome: EmailLinkConfirmOutcome };
type EmailLinkSendAttrs = { flow: EmailLinkFlow; result: EmailLinkSendResult };
type EmailVerificationTokenAttrs = { outcome: EmailVerificationTokenOutcome };
type AuthRateLimitAttrs = { endpoint: AuthRateLimitedEndpoint };
/** Turnstile-gated endpoints. Bounded literal union — never a raw path. */
type AuthTurnstileEndpoint = "register_begin" | "passkey_login_begin" | "recovery_email_begin";
type AuthTurnstileRejectedAttrs = { endpoint: AuthTurnstileEndpoint };
type GraphConnectionAttrs = { action: GraphConnectionAction; result: Result };
type GraphBlockAttrs = { action: GraphBlockAction; result: Result };
type OrgAttrs = { action: OrgAction; result: Result };
type OrgMemberAttrs = { action: OrgMemberAction; result: Result };
type ProfileSwitchAttrs = { action: ProfileSwitchAction; result: Result };
type ProfileCrudAttrs = { action: ProfileCrudAction; result: Result };

// ---------------------------------------------------------------------------
// Counters / histograms
// ---------------------------------------------------------------------------

const authRegisterAttempts = createCounter<RegisterAttrs>({
  name: OSN_METRICS.authRegisterAttempts,
  description: "Registration flow attempts by step and outcome",
  unit: "{attempt}",
});

const authRegisterDuration = createHistogram<RegisterAttrs>({
  name: OSN_METRICS.authRegisterDuration,
  description: "Registration flow duration by step",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const authLoginAttempts = createCounter<LoginAttrs>({
  name: OSN_METRICS.authLoginAttempts,
  description: "Login attempts by auth method and outcome",
  unit: "{attempt}",
});

const authLoginDuration = createHistogram<LoginAttrs>({
  name: OSN_METRICS.authLoginDuration,
  description: "Login flow duration by method",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const authTokenRefresh = createCounter<TokenRefreshAttrs>({
  name: OSN_METRICS.authTokenRefresh,
  description: "Access token refresh attempts",
  unit: "{attempt}",
});

const authHandleCheck = createCounter<HandleCheckAttrs>({
  name: OSN_METRICS.authHandleCheck,
  description: "Handle availability checks",
  unit: "{check}",
});

const authEmailLinkConfirmations = createCounter<EmailLinkConfirmAttrs>({
  name: OSN_METRICS.authEmailLinkConfirmations,
  description: "Emailed-link confirms by what they did to the request",
  unit: "{confirm}",
});

const authEmailLinkSends = createCounter<EmailLinkSendAttrs>({
  name: OSN_METRICS.authEmailLinkSends,
  description: "Emailed links by flow: sent, held back by a per-address cap, or failed",
  unit: "{message}",
});

const authEmailVerificationTokens = createCounter<EmailVerificationTokenAttrs>({
  name: OSN_METRICS.authEmailVerificationTokens,
  description: "Browser Email Verification API tokens sent with a sign-up, by what became of them",
  unit: "{token}",
});

const authRateLimited = createCounter<AuthRateLimitAttrs>({
  name: OSN_METRICS.authRateLimited,
  description: "Auth requests rejected by IP-based rate limiting",
  unit: "{rejection}",
});

const graphConnectionOps = createCounter<GraphConnectionAttrs>({
  name: OSN_METRICS.graphConnectionOps,
  description: "Social graph connection state changes",
  unit: "{operation}",
});

const graphBlockOps = createCounter<GraphBlockAttrs>({
  name: OSN_METRICS.graphBlockOps,
  description: "Social graph block/unblock operations",
  unit: "{operation}",
});

const orgOps = createCounter<OrgAttrs>({
  name: OSN_METRICS.orgOps,
  description: "Organisation CRUD operations",
  unit: "{operation}",
});

const orgMemberOps = createCounter<OrgMemberAttrs>({
  name: OSN_METRICS.orgMemberOps,
  description: "Organisation membership state changes",
  unit: "{operation}",
});

const profileSwitchAttempts = createCounter<ProfileSwitchAttrs>({
  name: OSN_METRICS.profileSwitchAttempts,
  description: "Profile switch/list attempts by action and outcome",
  unit: "{attempt}",
});

const profileCrudOps = createCounter<ProfileCrudAttrs>({
  name: OSN_METRICS.profileCrudOps,
  description: "Profile CRUD operations by action and outcome",
  unit: "{operation}",
});

const profileCrudDuration = createHistogram<ProfileCrudAttrs>({
  name: OSN_METRICS.profileCrudDuration,
  description: "Profile CRUD operation duration by action",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

// ---------------------------------------------------------------------------
// Error classification + sanitisation
// ---------------------------------------------------------------------------

/**
 * The three annotation keys {@link safeErrorSummary} may emit. `_tag` and
 * `message` come off an error object; `error` is the stringified value when
 * the thrown thing isn't an object at all. Exactly one of the two groups is
 * populated per call — the type stays flat because the caller spreads it into
 * a log-annotation record either way.
 */
type SafeErrorSummary = {
  _tag?: string;
  message?: string;
  error?: string;
};

/**
 * Extract a log-safe summary from an error. Avoids serialising raw `cause`
 * payloads (which may contain internal schema details) into structured log
 * annotations. Only `_tag` and `message` are kept — both are hardcoded
 * strings in the codebase, never user input.
 */
const safeErrorSummary = (err: unknown): SafeErrorSummary => {
  if (!err || typeof err !== "object") return { error: String(err) };
  const tag = (err as { _tag?: unknown })._tag;
  const msg = (err as { message?: unknown }).message;
  const summary: SafeErrorSummary = {};
  if (typeof tag === "string") summary._tag = tag;
  if (typeof msg === "string") summary.message = msg;
  return summary;
};

/**
 * Map any caught error (usually an Effect tagged error) into a bounded
 * `Result` string. Keeps metric cardinality bounded even when the underlying
 * error taxonomy grows. Matches are best-effort and intentionally conservative
 * — unknown error shapes collapse to `"error"`.
 */
const RESULT_SET: ReadonlySet<string> = new Set(RESULT_VALUES);
const isResult = (v: unknown): v is Result => typeof v === "string" && RESULT_SET.has(v);

export const classifyError = (err: unknown): Result => {
  if (!err || typeof err !== "object") return "error";

  // Effect tagged errors expose `_tag`.
  const tag = (err as { _tag?: unknown })._tag;

  // An explicit override beats every inference below — set where the
  // caller-facing message is deliberately vague and the true outcome would
  // otherwise be unobservable (see AuthError.metricResult). Only error
  // classes declared in this repo may steer a metric bucket, so the override
  // is read off a known tag rather than off any object: an error rebuilt from
  // an upstream JSON body must not be able to reclassify itself. Add a tag
  // here when another class declares the field.
  if (tag === "AuthError") {
    const override = (err as { metricResult?: unknown }).metricResult;
    if (isResult(override)) return override;
  }

  if (typeof tag === "string") {
    if (tag === "NotFoundError" || tag === "EventNotFound") return "not_found";
    if (tag === "ValidationError") return "validation_error";
    if (tag === "RateLimited") return "rate_limited";
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("rate limit")) return "rate_limited";
    if (msg.includes("not found") || msg.includes("no such")) return "not_found";
    if (msg.includes("forbidden") || msg.includes("not authori")) return "forbidden";
    if (msg.includes("unauthori")) return "unauthorized";
    if (msg.includes("invalid") || msg.includes("validation") || msg.includes("must be")) {
      return "validation_error";
    }
    if (msg.includes("already exists") || msg.includes("conflict") || msg.includes("taken")) {
      return "conflict";
    }
  }
  return "error";
};

// ---------------------------------------------------------------------------
// Effect helper wrappers — attach a span AND record the outcome in one call.
//
// Curried / pipe-friendly: call with the label first, then use in a `.pipe()`.
//
//   const beginRegistration = (email: string) =>
//     Effect.gen(function* () {
//       // ... existing body ...
//     }).pipe(withAuthRegister("begin"));
//
// The wrapper preserves the Effect's type signature unchanged.
// ---------------------------------------------------------------------------

const measureSeconds =
  (onDuration: (seconds: number, outcome: "ok" | "error") => void) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    Effect.suspend(() => {
      const start = Date.now();
      return effect.pipe(
        Effect.tap(() => Effect.sync(() => onDuration((Date.now() - start) / 1000, "ok"))),
        Effect.tapError(() => Effect.sync(() => onDuration((Date.now() - start) / 1000, "error"))),
      );
    });

export const withAuthRegister =
  (step: RegisterStep) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        // Duration result dimension is coarsened to ok/error to keep
        // histogram cardinality low.
        authRegisterDuration.record(seconds, {
          step,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`auth.register.${step}`),
      Effect.tap(() => Effect.sync(() => authRegisterAttempts.inc({ step, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.sync(() => authRegisterAttempts.inc({ step, result: classifyError(e) })),
      ),
    );

export const withAuthLogin =
  (method: AuthMethod) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        authLoginDuration.record(seconds, {
          method,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`auth.login.${method}`),
      Effect.tap(() => Effect.sync(() => authLoginAttempts.inc({ method, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.sync(() => authLoginAttempts.inc({ method, result: classifyError(e) })),
      ),
    );

export const withAuthTokenRefresh = <A, E, Ctx>(
  effect: Effect.Effect<A, E, Ctx>,
): Effect.Effect<A, E, Ctx> =>
  effect.pipe(
    Effect.withSpan("auth.token.refresh"),
    Effect.tap(() => Effect.sync(() => authTokenRefresh.inc({ result: "ok" }))),
    Effect.tapError((e) => Effect.sync(() => authTokenRefresh.inc({ result: classifyError(e) }))),
  );

export const withGraphConnectionOp =
  (action: GraphConnectionAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`graph.connection.${action}`),
      Effect.tap(() => Effect.sync(() => graphConnectionOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => graphConnectionOps.inc({ action, result: classifyError(e) })),
          Effect.logError("graph.connection operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

export const withGraphBlockOp =
  (action: GraphBlockAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`graph.block.${action}`),
      Effect.tap(() => Effect.sync(() => graphBlockOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => graphBlockOps.inc({ action, result: classifyError(e) })),
          Effect.logError("graph.block operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

// ---------------------------------------------------------------------------
// Simple fire-and-forget recording helpers (for code paths that can't be
// cleanly wrapped — e.g. handle-check which returns a plain boolean, or
// OTP-sent which happens as a side effect mid-flow).
// ---------------------------------------------------------------------------

export const metricAuthHandleCheck = (result: "available" | "taken" | "invalid"): void =>
  authHandleCheck.inc({ result });

export const metricEmailLinkSend = (flow: EmailLinkFlow, result: EmailLinkSendResult): void =>
  authEmailLinkSends.inc({ flow, result });

export const metricEmailVerificationToken = (outcome: EmailVerificationTokenOutcome): void =>
  authEmailVerificationTokens.inc({ outcome });

/**
 * Wraps an emailed-link confirm: span `auth.email_link.confirm`, a count of
 * what the confirm did, and an error log on a store failure. The outcome is
 * read off the effect's own answer through `outcomeOf`.
 */
export const withEmailLinkConfirm =
  <A>(outcomeOf: (answer: A) => EmailLinkConfirmOutcome) =>
  <E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.tap((answer) =>
        Effect.sync(() => authEmailLinkConfirmations.inc({ outcome: outcomeOf(answer) })),
      ),
      Effect.tapError((e) =>
        Effect.logError("auth.email_link operation failed", {
          step: "confirm",
          ...safeErrorSummary(e),
        }),
      ),
      Effect.withSpan("auth.email_link.confirm"),
    );

export const withOrgOp =
  (action: OrgAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`org.${action}`),
      Effect.tap(() => Effect.sync(() => orgOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => orgOps.inc({ action, result: classifyError(e) })),
          Effect.logError("org operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

export const withOrgMemberOp =
  (action: OrgMemberAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`org.member.${action}`),
      Effect.tap(() => Effect.sync(() => orgMemberOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => orgMemberOps.inc({ action, result: classifyError(e) })),
          Effect.logError("org.member operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

export const withProfileSwitch =
  (action: ProfileSwitchAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`auth.profile.${action}`),
      Effect.tap(() => Effect.sync(() => profileSwitchAttempts.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => profileSwitchAttempts.inc({ action, result: classifyError(e) })),
          Effect.logError("auth.profile operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

export const withProfileCrud =
  (action: ProfileCrudAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        profileCrudDuration.record(seconds, {
          action,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`profile.${action}`),
      Effect.tap(() => Effect.sync(() => profileCrudOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => profileCrudOps.inc({ action, result: classifyError(e) })),
          Effect.logError("profile.crud operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

export const metricAuthRateLimited = (endpoint: AuthRateLimitedEndpoint): void =>
  authRateLimited.inc({ endpoint });

const authTurnstileRejected = createCounter<AuthTurnstileRejectedAttrs>({
  name: OSN_METRICS.authTurnstileRejected,
  description: "Auth requests rejected by Turnstile siteverify (fail-closed)",
  unit: "{rejection}",
});

/** Records a fail-closed Turnstile rejection on a configured gate. */
export const metricAuthTurnstileRejected = (endpoint: AuthTurnstileEndpoint): void =>
  authTurnstileRejected.inc({ endpoint });

// ---------------------------------------------------------------------------
// Session rotation (Copenhagen Book C2)
// ---------------------------------------------------------------------------

type SessionRotationAttrs = { result: Result };
type SecurityInvalidationAttrs = { trigger: SecurityInvalidationTrigger };

const authSessionRotations = createCounter<SessionRotationAttrs>({
  name: OSN_METRICS.authSessionRotations,
  description: "Refresh token rotation attempts and outcomes",
  unit: "{rotation}",
});

const authSessionReuseDetected = createCounter<Record<never, never>>({
  name: OSN_METRICS.authSessionReuseDetected,
  description: "Replayed rotated-out session tokens detected (security signal)",
  unit: "{detection}",
});

const authSessionRotationRace = createCounter<Record<never, never>>({
  name: OSN_METRICS.authSessionRotationRace,
  description:
    "Benign concurrent/retried refresh grants tolerated within the rotation grace window (NOT reuse — the family is preserved)",
  unit: "{race}",
});

const authSessionFamilyRevoked = createCounter<Record<never, never>>({
  name: OSN_METRICS.authSessionFamilyRevoked,
  description: "Entire session families revoked due to token reuse detection",
  unit: "{revocation}",
});

const authSessionSecurityInvalidation = createCounter<SecurityInvalidationAttrs>({
  name: OSN_METRICS.authSessionSecurityInvalidation,
  description: "Session invalidation sweeps, by the security change or revoke that triggered them",
  unit: "{invalidation}",
});

export const withSessionRotation = <A, E, Ctx>(
  effect: Effect.Effect<A, E, Ctx>,
): Effect.Effect<A, E, Ctx> =>
  effect.pipe(
    Effect.withSpan("auth.session.rotate"),
    Effect.tap(() => Effect.sync(() => authSessionRotations.inc({ result: "ok" }))),
    Effect.tapError((e) =>
      Effect.sync(() => authSessionRotations.inc({ result: classifyError(e) })),
    ),
  );

export const metricSessionReuseDetected = (): void => authSessionReuseDetected.inc({});

export const metricSessionRotationRace = (): void => authSessionRotationRace.inc({});

export const metricSessionFamilyRevoked = (): void => authSessionFamilyRevoked.inc({});

export const metricSessionSecurityInvalidation = (trigger: SecurityInvalidationTrigger): void =>
  authSessionSecurityInvalidation.inc({ trigger });

/**
 * The routes that refuse a caller holding no live session (`liveSession` and
 * `liveSessionGate` in `routes/auth/context.ts`), named as their rate-limit
 * endpoints are.
 */
export type LiveSessionGateEndpoint =
  | "step_up_passkey_begin"
  | "step_up_passkey_complete"
  | "step_up_email_begin"
  | "step_up_email_status"
  | "step_up_email_resend"
  | "step_up_totp_complete"
  | "recovery_generate"
  | "email_change_begin"
  | "email_change_resend"
  | "email_change_complete"
  | "profile_switch"
  | "cross_device_approve"
  | "totp_enroll_begin"
  | "totp_enroll_complete"
  | "passkey_register_begin"
  | "oidc_client_create";
type SessionStaleRefusedAttrs = { endpoint: LiveSessionGateEndpoint };

const authSessionStaleRefused = createCounter<SessionStaleRefusedAttrs>({
  name: OSN_METRICS.authSessionStaleRefused,
  description:
    "Bearer calls refused 409 session_stale because the caller holds no live, ordinary session",
  unit: "{refusal}",
});

/** Records one `session_stale` refusal by the live-session gate. */
export const metricSessionStaleRefused = (endpoint: LiveSessionGateEndpoint): void =>
  authSessionStaleRefused.inc({ endpoint });

// ---------------------------------------------------------------------------
// cire organiser-session revocation (back-channel to cire-api)
// ---------------------------------------------------------------------------

/** What made osn-api end the account's cire organiser sessions. */
export type CireSessionRevokeTrigger = "sign_out_everywhere" | "connection_revoked";
/**
 * One request's outcome: `ok` (cire answered 2xx), `rejected` (any other
 * status, a redirect included), `timeout`, `error` (unreachable, or the
 * profile lookup failed and nothing was sent), or `unconfigured` (a setting
 * unset or unusable, so nothing was sent).
 */
export type CireSessionRevokeResult = "ok" | "rejected" | "timeout" | "error" | "unconfigured";
type CireSessionRevokeAttrs = {
  trigger: CireSessionRevokeTrigger;
  result: CireSessionRevokeResult;
};

const authCireSessionRevocations = createCounter<CireSessionRevokeAttrs>({
  name: OSN_METRICS.authCireSessionRevocations,
  description: "Requests asking cire-api to end an OSN profile's organiser sessions",
  unit: "{request}",
});

export const metricCireSessionRevocation = (
  trigger: CireSessionRevokeTrigger,
  result: CireSessionRevokeResult,
): void => authCireSessionRevocations.inc({ trigger, result });

// ---------------------------------------------------------------------------
// Ceremony / pending-state stores
//
// Every challenge / pending-registration / OTP / email-change / cross-device
// store shares one bounded metric surface: set / get / delete by the store's
// name and its backend — `memory` in one process, `durable_object` on the
// coordination store.
// ---------------------------------------------------------------------------

type CeremonyStoreBackend = "memory" | "durable_object";
type CeremonyStoreOp = "set" | "get" | "delete" | "guess" | "take" | "swap";
type CeremonyStoreOpAttrs = {
  namespace: CeremonyStoreName;
  op: CeremonyStoreOp;
  backend: CeremonyStoreBackend;
};

const authCeremonyStoreOps = createCounter<CeremonyStoreOpAttrs>({
  name: OSN_METRICS.authCeremonyStoreOps,
  description: "Ceremony/pending-state store operations by namespace, op, and backend",
  unit: "{operation}",
});

export const metricCeremonyStoreOp = (attrs: CeremonyStoreOpAttrs): void =>
  authCeremonyStoreOps.inc(attrs);

// ---------------------------------------------------------------------------
// Coordination store (the `COORDINATION` Durable Object)
//
// One count per call an object answers or fails, retries included, by the
// store's name, the operation and the outcome. Every attribute comes from a
// closed union: a key, an IP, an account or a stored value is never one.
// ---------------------------------------------------------------------------

type CoordinationStoreOpAttrs = {
  store: CoordinationStoreName;
  op: CoordinationOp;
  result: "ok" | "error";
};

const coordinationStoreOps = createCounter<CoordinationStoreOpAttrs>({
  name: OSN_METRICS.coordinationStoreOps,
  description: "Coordination store calls by store, operation and outcome",
  unit: "{operation}",
});

export const metricCoordinationStoreOp = (attrs: CoordinationStoreOpAttrs): void =>
  coordinationStoreOps.inc(attrs);

// ---------------------------------------------------------------------------
// Retention sweeps
// ---------------------------------------------------------------------------

/** A table a retention sweep deletes expired rows from. */
export type RetentionTable = "rotated_sessions";

type RetentionAttrs = { table: RetentionTable };

const retentionRowsDeleted = createCounter<RetentionAttrs>({
  name: OSN_METRICS.retentionRowsDeleted,
  description: "Rows a retention sweep deleted, by table",
  unit: "{row}",
});

const retentionCycleDuration = createHistogram<RetentionAttrs>({
  name: OSN_METRICS.retentionCycleDuration,
  description: "Time one retention sweep pass took, its pauses included, by table",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

/** One sweep pass over `table`: the rows it deleted and the seconds it took. */
export function metricRetentionSweep(
  table: RetentionTable,
  deleted: number,
  durationSeconds: number,
): void {
  retentionRowsDeleted.add(deleted, { table });
  retentionCycleDuration.record(durationSeconds, { table });
}

// ---------------------------------------------------------------------------
// Recovery-code per-account lockout
// ---------------------------------------------------------------------------

/**
 * `unavailable`: the counter could not be read or written, so the attempt was
 * refused without being counted.
 */
type RecoveryLockoutAttrs = { result: "recorded" | "locked" | "reset" | "unavailable" };

const authRecoveryLockout = createCounter<RecoveryLockoutAttrs>({
  name: OSN_METRICS.authRecoveryLockout,
  description: "Recovery-code and email-recovery per-account lockout events by outcome",
  unit: "{event}",
});

export const metricRecoveryLockout = (result: RecoveryLockoutAttrs["result"]): void =>
  authRecoveryLockout.inc({ result });

/**
 * Step-up links' per-account lockout: a wrong typed number counted
 * (`recorded`), the count at or past the threshold or a right number refused
 * while it holds (`locked`), and a counter that could not be read or written
 * (`unavailable`).
 */
type StepUpLockoutAttrs = { result: "recorded" | "locked" | "unavailable" };

const authStepUpLockout = createCounter<StepUpLockoutAttrs>({
  name: OSN_METRICS.authStepUpLockout,
  description: "Step-up link per-account lockout events by outcome",
  unit: "{event}",
});

export const metricStepUpLockout = (result: StepUpLockoutAttrs["result"]): void =>
  authStepUpLockout.inc({ result });

/**
 * Outcome of `POST /login/recovery/email/begin`: whether the address named an
 * account (`resolved`) or not.
 *
 * The endpoint answers an identical 202 on both, by design — which is exactly
 * why it needs a counter. Whether a link then went out, or was held back by
 * the lockout or a cap, is `osn.auth.email_link.sends{flow="recovery"}`,
 * counted in the send that runs after the answer.
 *
 * Aggregate counts only. The submitted identifier, the resolved account and the
 * link itself appear nowhere near this.
 */
type RecoveryEmailBeginAttrs = { result: "resolved" | "unknown_identifier" };

const authRecoveryEmailBegin = createCounter<RecoveryEmailBeginAttrs>({
  name: OSN_METRICS.authRecoveryEmailBegin,
  description: "Email account-recovery begin attempts by outcome (all answer 202)",
  unit: "{attempt}",
});

export const metricRecoveryEmailBegin = (result: RecoveryEmailBeginAttrs["result"]): void =>
  authRecoveryEmailBegin.inc({ result });

/**
 * Every refusal by the post-recovery cooldown.
 *
 * Needed for the same reason `authRecoveryEmailBegin` is: the caller gets one
 * generic message on all three branches, so a dashboard is the only place they
 * are told apart — and "the provenance rule is firing on real users" and "an
 * attacker is walking the register-then-assert pivot" look identical from a
 * status code. Counts only; no account, credential or address.
 */
const authRecoveryCooldown = createCounter<{ outcome: RecoveryCooldownOutcome }>({
  name: OSN_METRICS.authRecoveryCooldown,
  description: "Actions refused by the post-recovery cooldown, by which rule refused them",
  unit: "{refusal}",
});

export const metricRecoveryCooldown = (outcome: RecoveryCooldownOutcome): void =>
  authRecoveryCooldown.inc({ outcome });

/**
 * Outcome of `POST /recovery/disown`. Every branch answers 202, so this is the
 * only signal that separates a real revocation from a guessed token — and
 * `store_error`, which revokes nothing, from either.
 */
const authRecoveryDisown = createCounter<{ result: RecoveryDisownResult }>({
  name: OSN_METRICS.authRecoveryDisown,
  description: "Recovery disown attempts by outcome (all answer 202)",
  unit: "{attempt}",
});

export const metricRecoveryDisown = (result: RecoveryDisownResult): void =>
  authRecoveryDisown.inc({ result });

/**
 * How a restricted recovery session's enrolment fared against the passkey
 * ceiling. None of the three values is a refusal — a recovery is never refused
 * for want of a slot. `ceiling_yielded` is the one to alert on: the account
 * ended above the ceiling because it held nothing this episode had lent, and an
 * account reaching it repeatedly is accumulating credentials nobody prunes.
 */
const authRecoveryPasskeyReclaim = createCounter<{ result: RecoveryPasskeyReclaimResult }>({
  name: OSN_METRICS.authRecoveryPasskeyReclaim,
  description: "Recovery-session passkey enrolments by how they met the ceiling",
  unit: "{enrolment}",
});

export const metricRecoveryPasskeyReclaim = (result: RecoveryPasskeyReclaimResult): void =>
  authRecoveryPasskeyReclaim.inc({ result });

// ---------------------------------------------------------------------------
// Recovery codes (Copenhagen Book M2)
// ---------------------------------------------------------------------------

type RecoveryConsumeAttrs = { result: RecoveryCodeConsumeResult };
type RecoveryStepAttrs = { step: RecoveryCodeStep; result: Result };

const authRecoveryCodesGenerated = createCounter<Record<never, never>>({
  name: OSN_METRICS.authRecoveryCodesGenerated,
  description: "Recovery code sets generated (each event = one 10-code batch)",
  unit: "{set}",
});

const authRecoveryCodeConsumed = createCounter<RecoveryConsumeAttrs>({
  name: OSN_METRICS.authRecoveryCodeConsumed,
  description: "Recovery code consume attempts by outcome",
  unit: "{attempt}",
});

const authRecoveryDuration = createHistogram<RecoveryStepAttrs>({
  name: OSN_METRICS.authRecoveryDuration,
  description: "Account-recovery duration by step (recovery code, email OTP, TOTP)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

export const metricRecoveryCodesGenerated = (): void => authRecoveryCodesGenerated.inc({});

export const metricRecoveryCodeConsumed = (result: RecoveryCodeConsumeResult): void =>
  authRecoveryCodeConsumed.inc({ result });

export const withAuthRecovery =
  (step: RecoveryCodeStep) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        authRecoveryDuration.record(seconds, {
          step,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`auth.recovery.${step}`),
    );

// ---------------------------------------------------------------------------
// Origin guard
// ---------------------------------------------------------------------------

type OriginGuardAttrs = { reason: OriginGuardRejectionReason };

const authOriginGuardRejections = createCounter<OriginGuardAttrs>({
  name: OSN_METRICS.authOriginGuardRejections,
  description: "Requests rejected by Origin header validation (CSRF guard)",
  unit: "{rejection}",
});

export const metricOriginGuardRejection = (reason: OriginGuardRejectionReason): void =>
  authOriginGuardRejections.inc({ reason });

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

const authJwksServed = createCounter<Record<never, never>>({
  name: OSN_METRICS.authJwksServed,
  description: "JWKS public key endpoint served (GET /.well-known/jwks.json)",
  unit: "{request}",
});

export const metricAuthJwksServed = (): void => authJwksServed.inc({});

// ---------------------------------------------------------------------------
// OIDC provider
// ---------------------------------------------------------------------------

type OidcAuthorizeAttrs = { result: OidcAuthorizeResult; clientKind: OidcClientKind };
type OidcTokenAttrs = { result: OidcTokenResult; clientKind: OidcClientKind };
type OidcConsentAttrs = { clientKind: OidcClientKind };

const oidcAuthorize = createCounter<OidcAuthorizeAttrs>({
  name: OSN_METRICS.oidcAuthorize,
  description: "Calls to the OIDC authorization endpoint, by outcome",
  unit: "{request}",
});

const oidcToken = createCounter<OidcTokenAttrs>({
  name: OSN_METRICS.oidcToken,
  description: "Authorization-code exchanges at the OIDC token endpoint, by outcome",
  unit: "{exchange}",
});

const oidcConsentGranted = createCounter<OidcConsentAttrs>({
  name: OSN_METRICS.oidcConsentGranted,
  description: "Accounts newly linked to a relying party (first consent granted)",
  unit: "{grant}",
});

export const metricOidcAuthorize = (attrs: OidcAuthorizeAttrs): void => oidcAuthorize.inc(attrs);
export const metricOidcToken = (attrs: OidcTokenAttrs): void => oidcToken.inc(attrs);
export const metricOidcConsentGranted = (clientKind: OidcClientKind): void =>
  oidcConsentGranted.inc({ clientKind });

// ---------------------------------------------------------------------------
// Step-up (sudo mode)
// ---------------------------------------------------------------------------

type StepUpIssuedAttrs = { factor: StepUpFactor };
type StepUpVerifiedAttrs = { result: StepUpVerifyResult };
type SessionOpAttrs = { action: SessionAction; result: Result };
type EmailChangeAttrs = { step: EmailChangeStep; result: Result };

const authStepUpIssued = createCounter<StepUpIssuedAttrs>({
  name: OSN_METRICS.authStepUpIssued,
  description: "Step-up tokens minted, by the factor that authorised issuance",
  unit: "{token}",
});

const authStepUpVerified = createCounter<StepUpVerifiedAttrs>({
  name: OSN_METRICS.authStepUpVerified,
  description: "Step-up token verification outcomes on gated endpoints",
  unit: "{verification}",
});

const authSessionOps = createCounter<SessionOpAttrs>({
  name: OSN_METRICS.authSessionOps,
  description: "Caller-initiated session-management operations",
  unit: "{operation}",
});

const authEmailChangeAttempts = createCounter<EmailChangeAttrs>({
  name: OSN_METRICS.authEmailChangeAttempts,
  description: "Email-change ceremony attempts by step and outcome",
  unit: "{attempt}",
});

const authEmailChangeDuration = createHistogram<EmailChangeAttrs>({
  name: OSN_METRICS.authEmailChangeDuration,
  description: "Email-change ceremony duration by step",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

export const metricStepUpIssued = (factor: StepUpFactor): void => authStepUpIssued.inc({ factor });

export const metricStepUpVerified = (result: StepUpVerifyResult): void =>
  authStepUpVerified.inc({ result });

export const withStepUp =
  (step: StepUpStep) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(Effect.withSpan(`auth.step_up.${step}`));

export const withSessionOp =
  (action: SessionAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`auth.session.${action}`),
      Effect.tap(() => Effect.sync(() => authSessionOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => authSessionOps.inc({ action, result: classifyError(e) })),
          Effect.logError("auth.session operation failed", {
            action,
            ...safeErrorSummary(e),
          }),
        ]),
      ),
    );

export const withEmailChange =
  (step: EmailChangeStep) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        authEmailChangeDuration.record(seconds, {
          step,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`auth.account.email_change.${step}`),
      Effect.tap(() => Effect.sync(() => authEmailChangeAttempts.inc({ step, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => authEmailChangeAttempts.inc({ step, result: classifyError(e) })),
          Effect.logError("auth.account.email_change failed", {
            step,
            ...safeErrorSummary(e),
          }),
        ]),
      ),
    );

// ---------------------------------------------------------------------------
// Security events — out-of-band audit trail for account-level
// security actions so the client can surface "did you do this?" banners.
// ---------------------------------------------------------------------------

type SecurityEventAttrs = { kind: SecurityEventKind };
type SecurityEventNotifyAttrs = {
  kind: SecurityEventKind;
  result: SecurityEventNotifyResult;
};
type SecurityEventNotifyDurationAttrs = { result: "ok" | "error" };

const authSecurityEventRecorded = createCounter<SecurityEventAttrs>({
  name: OSN_METRICS.authSecurityEventRecorded,
  description: "Security-event audit rows recorded",
  unit: "{event}",
});

const authSecurityEventNotified = createCounter<SecurityEventNotifyAttrs>({
  name: OSN_METRICS.authSecurityEventNotified,
  description: "Out-of-band security-event notification outcomes",
  unit: "{notification}",
});

const authSecurityEventAcknowledged = createCounter<SecurityEventAttrs>({
  name: OSN_METRICS.authSecurityEventAcknowledged,
  description: "Security-event banners acknowledged by the account holder",
  unit: "{ack}",
});

const authSecurityEventNotifyDuration = createHistogram<SecurityEventNotifyDurationAttrs>({
  name: OSN_METRICS.authSecurityEventNotifyDuration,
  description: "Out-of-band security-event notification dispatch duration",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

export const metricSecurityEventRecorded = (kind: SecurityEventKind): void =>
  authSecurityEventRecorded.inc({ kind });

export const metricSecurityEventNotified = (
  kind: SecurityEventKind,
  result: SecurityEventNotifyResult,
): void => authSecurityEventNotified.inc({ kind, result });

export const metricSecurityEventAcknowledged = (kind: SecurityEventKind): void =>
  authSecurityEventAcknowledged.inc({ kind });

export const metricSecurityEventNotifyDuration = (seconds: number, result: "ok" | "error"): void =>
  authSecurityEventNotifyDuration.record(seconds, { result });

// ---------------------------------------------------------------------------
// Passkey management (M-PK) — caller-initiated list / rename / delete on
// existing credentials. Login/register flows keep their own metric families.
// ---------------------------------------------------------------------------

type PasskeyOpAttrs = { action: PasskeyAction; result: Result };
type PasskeyDurationAttrs = { action: PasskeyAction; result: "ok" | "error" };
type PasskeyLoginDiscoverableAttrs = { result: Result };

const authPasskeyOps = createCounter<PasskeyOpAttrs>({
  name: OSN_METRICS.authPasskeyOps,
  description: "Passkey management operations (list / rename / delete) by outcome",
  unit: "{operation}",
});

const authPasskeyDuration = createHistogram<PasskeyDurationAttrs>({
  name: OSN_METRICS.authPasskeyDuration,
  description: "Passkey management operation duration by action",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const authPasskeyLoginDiscoverable = createCounter<PasskeyLoginDiscoverableAttrs>({
  name: OSN_METRICS.authPasskeyLoginDiscoverable,
  description: "Identifier-free (discoverable credential / conditional-UI) passkey login attempts",
  unit: "{attempt}",
});

export const withPasskeyOp =
  (action: PasskeyAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        authPasskeyDuration.record(seconds, { action, result: outcome === "ok" ? "ok" : "error" });
      }),
      Effect.withSpan(`auth.passkey.${action}`),
      Effect.tap(() => Effect.sync(() => authPasskeyOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => authPasskeyOps.inc({ action, result: classifyError(e) })),
          Effect.logError("auth.passkey operation failed", { action, ...safeErrorSummary(e) }),
        ]),
      ),
    );

export const metricPasskeyLoginDiscoverable = (result: Result): void =>
  authPasskeyLoginDiscoverable.inc({ result });

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
//
// Nothing here is dimensioned by account, credential id, step counter or code.
// `authTotpVerified` is the only place the reason for a rejection is recorded
// at all: every failing path answers one generic error on the wire, so a
// response that distinguished them would say whether an account has a second
// factor. The dashboard gets the distinction; the caller does not.
// ---------------------------------------------------------------------------

type TotpOpAttrs = { op: TotpOp; result: Result };
type TotpVerifiedAttrs = { result: TotpVerifyResult };
/**
 * How a key rotation is watched. `ok` is a credential moved off the outgoing
 * key; when it stops climbing while `osn.auth.totp.verified{result=ok}` keeps
 * going, the drain is done and `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` can be
 * deleted. Two values, no version and no account: the row count is the signal,
 * and a version attribute would grow a series per rotation forever.
 */
type TotpRekeyedAttrs = { result: TotpRekeyResult };
/**
 * `scope` separates the two surfaces that check TOTP codes. They keep separate
 * counters (see `checkTotpCode`), and without this attribute a dashboard cannot
 * tell a grinding attack on the UNAUTHENTICATED recovery route from one on the
 * authenticated step-up. Two values, four results — eight series.
 * `unavailable`: the counter could not be read or written, so the code was
 * refused without being counted.
 */
type TotpLockoutAttrs = {
  result: "recorded" | "locked" | "reset" | "unavailable";
  scope: TotpLockoutScope;
};

/** Which ceremony a TOTP code check belongs to. */
export type TotpLockoutScope = "step_up" | "recovery";

const authTotpOps = createCounter<TotpOpAttrs>({
  name: OSN_METRICS.authTotpOps,
  description: "TOTP enrolment / disable / status / verify operations by outcome",
  unit: "{operation}",
});

const authTotpDuration = createHistogram<TotpOpAttrs>({
  name: OSN_METRICS.authTotpDuration,
  description: "TOTP operation duration by op",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const authTotpVerified = createCounter<TotpVerifiedAttrs>({
  name: OSN_METRICS.authTotpVerified,
  description: "TOTP code verification outcomes, including replay and lockout rejections",
  unit: "{verification}",
});

const authTotpLockout = createCounter<TotpLockoutAttrs>({
  name: OSN_METRICS.authTotpLockout,
  description: "TOTP per-account failed-code lockout events by outcome",
  unit: "{event}",
});

const authTotpRekeyed = createCounter<TotpRekeyedAttrs>({
  name: OSN_METRICS.authTotpRekeyed,
  description: "TOTP credentials re-encrypted onto the current key, by outcome",
  unit: "{credential}",
});

export const metricTotpVerified = (result: TotpVerifyResult): void =>
  authTotpVerified.inc({ result });

export const metricTotpRekeyed = (result: TotpRekeyResult): void => authTotpRekeyed.inc({ result });

export const metricTotpLockout = (
  result: TotpLockoutAttrs["result"],
  scope: TotpLockoutScope,
): void => authTotpLockout.inc({ result, scope });

export const withTotpOp =
  (op: TotpOp) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        authTotpDuration.record(seconds, { op, result: outcome === "ok" ? "ok" : "error" });
      }),
      Effect.withSpan(`auth.totp.${op}`),
      Effect.tap(() => Effect.sync(() => authTotpOps.inc({ op, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => authTotpOps.inc({ op, result: classifyError(e) })),
          Effect.logError("auth.totp operation failed", { op, ...safeErrorSummary(e) }),
        ]),
      ),
    );

// ---------------------------------------------------------------------------
// Cross-device login
// ---------------------------------------------------------------------------

type CrossDeviceAttrs = { step: CrossDeviceStep; result: Result };
type CrossDeviceDurationAttrs = { step: CrossDeviceStep; result: "ok" | "error" };

const authCrossDeviceAttempts = createCounter<CrossDeviceAttrs>({
  name: OSN_METRICS.authCrossDeviceAttempts,
  description: "Cross-device login attempts by step and outcome",
  unit: "{attempt}",
});

const authCrossDeviceDuration = createHistogram<CrossDeviceDurationAttrs>({
  name: OSN_METRICS.authCrossDeviceDuration,
  description: "Cross-device login step duration",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

export const withCrossDeviceOp =
  (step: CrossDeviceStep) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        authCrossDeviceDuration.record(seconds, {
          step,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`auth.cross_device.${step}`),
      Effect.tap(() => Effect.sync(() => authCrossDeviceAttempts.inc({ step, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.all([
          Effect.sync(() => authCrossDeviceAttempts.inc({ step, result: classifyError(e) })),
          Effect.logError("auth.cross_device operation failed", {
            step,
            ...safeErrorSummary(e),
          }),
        ]),
      ),
    );

// ---------------------------------------------------------------------------
// Account deletion (GDPR Art. 17)
// ---------------------------------------------------------------------------

type DeletionRequestedAttrs = { result: DeletionRequestResult };
/** Bounded outcome enum for the account data-export endpoint. */
export type ExportRequestResult =
  | "ok"
  | "unauthorized"
  | "step_up_failed"
  | "rate_limited"
  | "error";
type ExportRequestedAttrs = { result: ExportRequestResult };
type DeletionCompletedAttrs = {
  result: DeletionCompletedResult;
  source: DeletionCompletedSource;
};
type DeletionDurationAttrs = { phase: DeletionPhase; result: "ok" | "error" };
type DeletionFanoutAttrs = { service: DeletionFanoutService; result: DeletionFanoutResult };
type DeletionFanoutPendingAgeAttrs = { service: DeletionFanoutService };
type AppEnrollmentJoinedAttrs = { app: AppEnrollmentApp };
type AppEnrollmentLeftAttrs = { app: AppEnrollmentApp; result: Result };

const accountDeletionRequested = createCounter<DeletionRequestedAttrs>({
  name: OSN_METRICS.accountDeletionRequested,
  description: "Account deletion request attempts (Flow A — full OSN account)",
  unit: "{request}",
});

const accountDeletionCompleted = createCounter<DeletionCompletedAttrs>({
  name: OSN_METRICS.accountDeletionCompleted,
  description: "Account deletion lifecycle completion events",
  unit: "{event}",
});

const accountDeletionDuration = createHistogram<DeletionDurationAttrs>({
  name: OSN_METRICS.accountDeletionDuration,
  description: "Account deletion phase duration (soft = request handler, hard = sweeper)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const accountDeletionFanout = createCounter<DeletionFanoutAttrs>({
  name: OSN_METRICS.accountDeletionFanout,
  description: "Per-bridge fan-out outcomes during cross-service deletion",
  unit: "{call}",
});

const accountDeletionFanoutPendingAge = createHistogram<DeletionFanoutPendingAgeAttrs>({
  name: OSN_METRICS.accountDeletionFanoutPendingAge,
  description:
    "Age (seconds) of unfinished fan-out jobs at sweeper scan time — early warning for a stuck bridge",
  unit: "s",
  // Minute-scale buckets — these jobs are background-retried, not request-path latency.
  boundaries: [60, 300, 900, 1800, 3600, 7200, 14400, 43200, 86400],
});

const appEnrollmentJoined = createCounter<AppEnrollmentJoinedAttrs>({
  name: OSN_METRICS.appEnrollmentJoined,
  description: "App enrollment rows created (lazy provisioning on first authenticated app call)",
  unit: "{enrollment}",
});

const appEnrollmentLeft = createCounter<AppEnrollmentLeftAttrs>({
  name: OSN_METRICS.appEnrollmentLeft,
  description: "App enrollments closed (Flow B leave-app or Flow A cascade)",
  unit: "{enrollment}",
});

const accountExportRequested = createCounter<ExportRequestedAttrs>({
  name: OSN_METRICS.accountExportRequested,
  description: "Account data-export request attempts (DSAR Art. 15 / 20)",
  unit: "{request}",
});

export const metricAccountExportRequested = (result: ExportRequestResult): void =>
  accountExportRequested.inc({ result });

export const metricAccountDeletionRequested = (result: DeletionRequestResult): void =>
  accountDeletionRequested.inc({ result });

export const metricAccountDeletionCompleted = (
  result: DeletionCompletedResult,
  source: DeletionCompletedSource,
): void => accountDeletionCompleted.inc({ result, source });

export const metricAccountDeletionFanout = (
  service: DeletionFanoutService,
  result: DeletionFanoutResult,
): void => accountDeletionFanout.inc({ service, result });

export const metricAccountDeletionFanoutPendingAge = (
  service: DeletionFanoutService,
  ageSeconds: number,
): void => accountDeletionFanoutPendingAge.record(ageSeconds, { service });

export const metricAppEnrollmentJoined = (app: AppEnrollmentApp): void =>
  appEnrollmentJoined.inc({ app });

export const metricAppEnrollmentLeft = (app: AppEnrollmentApp, result: Result): void =>
  appEnrollmentLeft.inc({ app, result });

/**
 * Wraps a deletion phase Effect with span + duration histogram. Counter
 * emission for `requested` / `completed` is via the explicit metric
 * helpers above so call sites can pick the right `result` / `source`
 * union value.
 */
export const withAccountDeletion =
  (phase: DeletionPhase) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      measureSeconds((seconds, outcome) => {
        accountDeletionDuration.record(seconds, {
          phase,
          result: outcome === "ok" ? "ok" : "error",
        });
      }),
      Effect.withSpan(`account.deletion.${phase}`),
      Effect.tapError((e) =>
        Effect.logError("account.deletion failed", { phase, ...safeErrorSummary(e) }),
      ),
    );
