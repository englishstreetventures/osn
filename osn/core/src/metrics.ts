/**
 * OSN Core domain metrics.
 *
 * Single source of truth — every counter/histogram for auth + social graph
 * lives here. Handlers and services use the `with*` helper wrappers below,
 * which attach a span AND record the result in one call.
 *
 * See `CLAUDE.md` "Observability" section for the full rules.
 */

import { Effect } from "effect";
import {
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
} from "@shared/observability/metrics";
import type {
  AuthMethod,
  GraphBlockAction,
  GraphConnectionAction,
  RegisterStep,
  Result,
} from "@shared/observability/metrics";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const OSN_METRICS = {
  authRegisterAttempts: "osn.auth.register.attempts",
  authRegisterDuration: "osn.auth.register.duration",
  authLoginAttempts: "osn.auth.login.attempts",
  authLoginDuration: "osn.auth.login.duration",
  authTokenRefresh: "osn.auth.token.refresh",
  authHandleCheck: "osn.auth.handle.check",
  authOtpSent: "osn.auth.otp.sent",
  authMagicLinkSent: "osn.auth.magic_link.sent",
  graphConnectionOps: "osn.graph.connection.operations",
  graphBlockOps: "osn.graph.block.operations",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes
// ---------------------------------------------------------------------------

type RegisterAttrs = { step: RegisterStep; result: Result };
type LoginAttrs = { method: AuthMethod; result: Result };
type TokenRefreshAttrs = { result: Result };
type HandleCheckAttrs = { result: "available" | "taken" | "invalid" };
type OtpSentAttrs = { purpose: "registration" | "login" };
type MagicLinkSentAttrs = { result: Result };
type GraphConnectionAttrs = { action: GraphConnectionAction; result: Result };
type GraphBlockAttrs = { action: GraphBlockAction; result: Result };

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

const authMagicLinkSent = createCounter<MagicLinkSentAttrs>({
  name: OSN_METRICS.authMagicLinkSent,
  description: "Magic-link emails",
  unit: "{message}",
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

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

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
        Effect.sync(() => graphConnectionOps.inc({ action, result: classifyError(e) })),
      ),
    );

export const withGraphBlockOp =
  (action: GraphBlockAction) =>
  <A, E, Ctx>(effect: Effect.Effect<A, E, Ctx>): Effect.Effect<A, E, Ctx> =>
    effect.pipe(
      Effect.withSpan(`graph.block.${action}`),
      Effect.tap(() => Effect.sync(() => graphBlockOps.inc({ action, result: "ok" }))),
      Effect.tapError((e) =>
        Effect.sync(() => graphBlockOps.inc({ action, result: classifyError(e) })),
      ),
    );

// ---------------------------------------------------------------------------
// Simple fire-and-forget recording helpers (for code paths that can't be
// cleanly wrapped — e.g. handle-check which returns a plain boolean, or
// OTP-sent which happens as a side effect mid-flow).
// ---------------------------------------------------------------------------

export const metricAuthHandleCheck = (result: "available" | "taken" | "invalid"): void =>
  authHandleCheck.inc({ result });

export const metricAuthOtpSent = (purpose: "registration" | "login"): void =>
  authOtpSent.inc({ purpose });

export const metricAuthMagicLinkSent = (result: Result): void => authMagicLinkSent.inc({ result });
