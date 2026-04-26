/**
 * OSN Core domain metrics.
 *
 * Single source of truth — every counter/histogram for auth + social graph
 * lives here. Handlers and services use the `with*` helper wrappers below,
 * which attach a span AND record the result in one call.
 *
 * See `CLAUDE.md` "Observability" section for the full rules.
 */

import {
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
} from "@shared/observability/metrics";
import type {
  AuthMethod,
  AuthRateLimitedEndpoint,
  CrossDeviceStep,
  EmailChangeStep,
  GraphBlockAction,
  GraphConnectionAction,
  OrgAction,
  OrgMemberAction,
  OriginGuardRejectionReason,
  PasskeyAction,
  ProfileCrudAction,
  ProfileSwitchAction,
  RecoveryCodeConsumeResult,
  RecoveryCodeStep,
  RegisterStep,
  Result,
  RotatedStoreAction,
  RotatedStoreBackend,
  RotatedStoreResult,
  SecurityEventKind,
  SecurityEventNotifyResult,
  SecurityInvalidationTrigger,
  SessionAction,
  StepUpFactor,
  StepUpStep,
  StepUpVerifyResult,
} from "@shared/observability/metrics";
import { Effect } from "effect";

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
  authOtpSent: "osn.auth.otp.sent",
  authRateLimited: "osn.auth.rate_limited",
  authSessionRotations: "osn.auth.session.rotations",
  authSessionReuseDetected: "osn.auth.session.reuse_detected",
  authSessionFamilyRevoked: "osn.auth.session.family_revoked",
  authSessionRotatedStoreOps: "osn.auth.session.rotated_store.operations",
  authSessionRotatedStoreDuration: "osn.auth.session.rotated_store.duration",
  authSessionSecurityInvalidation: "osn.auth.session.security_invalidation",
  authRecoveryCodesGenerated: "osn.auth.recovery.codes_generated",
  authRecoveryCodeConsumed: "osn.auth.recovery.code_consumed",
  authRecoveryDuration: "osn.auth.recovery.duration",
  authStepUpIssued: "osn.auth.step_up.issued",
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
  graphConnectionOps: "osn.graph.connection.operations",
  graphBlockOps: "osn.graph.block.operations",
  orgOps: "osn.org.operations",
  orgMemberOps: "osn.org.member.operations",
  profileSwitchAttempts: "osn.auth.profile_switch.attempts",
  profileCrudOps: "osn.profile.crud.operations",
  profileCrudDuration: "osn.profile.crud.duration",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes
// ---------------------------------------------------------------------------

type RegisterAttrs = { step: RegisterStep; result: Result };
type LoginAttrs = { method: AuthMethod; result: Result };
type TokenRefreshAttrs = { result: Result };
type HandleCheckAttrs = { result: "available" | "taken" | "invalid" };
type OtpSentAttrs = { purpose: "registration" | "step_up" | "email_change" };
type AuthRateLimitAttrs = { endpoint: AuthRateLimitedEndpoint };
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

const authOtpSent = createCounter<OtpSentAttrs>({
  name: OSN_METRICS.authOtpSent,
  description: "OTP codes successfully sent",
  unit: "{message}",
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
 * Extract a log-safe summary from an error. Avoids serialising raw `cause`
 * payloads (which may contain internal schema details) into structured log
 * annotations. Only `_tag` and `message` are kept — both are hardcoded
 * strings in the codebase, never user input.
 */
const safeErrorSummary = (err: unknown): Record<string, unknown> => {
  if (!err || typeof err !== "object") return { error: String(err) };
  const tag = (err as { _tag?: unknown })._tag;
  const msg = (err as { message?: unknown }).message;
  return {
    ...(typeof tag === "string" ? { _tag: tag } : {}),
    ...(typeof msg === "string" ? { message: msg } : {}),
  };
};

/**
 * Map any caught error (usually an Effect tagged error) into a bounded
 * `Result` string. Keeps metric cardinality bounded even when the underlying
 * error taxonomy grows. Matches are best-effort and intentionally conservative
 * — unknown error shapes collapse to `"error"`.
 */
export const classifyError = (err: unknown): Result => {
  if (!err || typeof err !== "object") return "error";

  // Effect tagged errors expose `_tag`.
  const tag = (err as { _tag?: unknown })._tag;
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

export const metricAuthOtpSent = (purpose: "registration" | "step_up" | "email_change"): void =>
  authOtpSent.inc({ purpose });

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

const authSessionFamilyRevoked = createCounter<Record<never, never>>({
  name: OSN_METRICS.authSessionFamilyRevoked,
  description: "Entire session families revoked due to token reuse detection",
  unit: "{revocation}",
});

const authSessionSecurityInvalidation = createCounter<SecurityInvalidationAttrs>({
  name: OSN_METRICS.authSessionSecurityInvalidation,
  description: "Sessions invalidated due to security events (H1)",
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

export const metricSessionFamilyRevoked = (): void => authSessionFamilyRevoked.inc({});

export const metricSessionSecurityInvalidation = (trigger: SecurityInvalidationTrigger): void =>
  authSessionSecurityInvalidation.inc({ trigger });

// ---------------------------------------------------------------------------
// Rotated-session store (S-H1: cluster-safe C2 reuse detection)
// ---------------------------------------------------------------------------

type RotatedStoreOpAttrs = {
  action: RotatedStoreAction;
  result: RotatedStoreResult;
  backend: RotatedStoreBackend;
};
type RotatedStoreDurationAttrs = {
  action: RotatedStoreAction;
  backend: RotatedStoreBackend;
};

const authSessionRotatedStoreOps = createCounter<RotatedStoreOpAttrs>({
  name: OSN_METRICS.authSessionRotatedStoreOps,
  description:
    "Rotated-session store operations (C2 reuse detection) by action, outcome, and backend",
  unit: "{operation}",
});

const authSessionRotatedStoreDuration = createHistogram<RotatedStoreDurationAttrs>({
  name: OSN_METRICS.authSessionRotatedStoreDuration,
  description: "Rotated-session store operation latency by action and backend",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

export const metricRotatedStoreOp = (attrs: RotatedStoreOpAttrs): void =>
  authSessionRotatedStoreOps.inc(attrs);

export const metricRotatedStoreDuration = (
  seconds: number,
  attrs: RotatedStoreDurationAttrs,
): void => authSessionRotatedStoreDuration.record(seconds, attrs);

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
  description: "Recovery code generate/consume duration by step",
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
// Origin guard (M1)
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
// Security events (M-PK1b) — out-of-band audit trail for account-level
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
  description: "Security-event audit rows recorded (M-PK1b)",
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
