/**
 * Operator alerts from the R2 orphan reconcilers: a run held on a halving of
 * rows, a hold ended, a stop object in place, or a tier with the reconcilers
 * disabled. The daily cron sends them to the address `claimReviewAlertTarget`
 * resolves (`CIRE_OPS_EMAIL`, with a Resend key, on a deployed tier).
 *
 * The cron's other mail goes out at the same moment, and Resend answers a burst
 * with a rate-limit refusal it does not retry, so a failed send is tried twice
 * more, a few seconds apart. After that it is logged as an error and dropped:
 * the error channel is `never`, so mail can never stop a reconcile.
 */

import { EmailService } from "@shared/email";
import { Effect } from "effect";

import type { R2BucketLabel } from "../services/r2-cleanup";
import type { ReconcileAlert } from "../services/r2-reconcile";

/** Everything the cron tells the operator about the reconcilers. */
export type OperatorReconcileAlert = ReconcileAlert | { readonly kind: "disabled" };

export interface ReconcileAlertInput {
  /** The operator address from deployment config. */
  readonly to: string;
  readonly env: "dev" | "production";
  readonly alert: OperatorReconcileAlert;
}

/** Sends a single alert may make before it is dropped. */
const ATTEMPTS = 3;

/**
 * The bucket a binding names in each deployed tier, as `cire/api/wrangler.toml`
 * declares it; tests/lib/reconcile-alert-email.test.ts holds the two together.
 */
export function reconcileBucketName(label: R2BucketLabel, env: "dev" | "production"): string {
  const name = label === "sheets" ? "cire-sheets" : "cire-assets";
  return env === "production" ? name : `${name}-dev`;
}

export function sendReconcileAlert(
  input: ReconcileAlertInput,
  options: { readonly retryDelayMs?: number } = {},
): Effect.Effect<void, never, EmailService> {
  const delay = options.retryDelayMs ?? 2_000;
  const { alert, env } = input;
  const data =
    alert.kind === "disabled"
      ? { kind: alert.kind, env }
      : { ...alert, env, bucket: reconcileBucketName(alert.bucket, env) };

  return Effect.gen(function* () {
    const emailSvc = yield* EmailService;
    const send = emailSvc.send({ template: "r2-reconcile-alert", to: input.to, data });
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const exit = yield* Effect.exit(send);
      if (exit._tag === "Success") return;
      if (attempt < ATTEMPTS) yield* Effect.sleep(`${delay} millis`);
    }
    yield* Effect.logError("r2 reconcile alert send failed", {
      kind: alert.kind,
      attempts: ATTEMPTS,
    });
  }).pipe(
    Effect.catchCause(() =>
      Effect.logError("r2 reconcile alert send failed", { kind: alert.kind, reason: "defect" }),
    ),
  );
}
