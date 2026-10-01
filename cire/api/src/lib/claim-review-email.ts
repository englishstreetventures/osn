/**
 * Fail-soft operator reminder that vendor claims are waiting for review.
 *
 * The daily cron calls this once when at least one claim waits, so the
 * operator gets at most one email a day. It names counts only: the address is
 * an operator's, but a listing or claimant detail would still be personal data
 * in a mailbox nobody audits, and the review script shows them anyway.
 *
 * Error channel is `never`: an `EmailError` or defect is logged and counted,
 * never raised, so a mail outage cannot stop the hand-off in the same sweep.
 */

import { EmailService } from "@shared/email";
import { Effect } from "effect";

import { metricVendorClaimReview } from "../metrics";
import type { PendingClaimsSummary } from "../services/claim-review";

export interface ClaimReviewAlertInput {
  /** The operator address from deployment config. */
  readonly to: string;
  /** The review script's `--env` for this deployment. */
  readonly env: "dev" | "production";
  readonly summary: PendingClaimsSummary;
}

export function sendClaimReviewAlert(
  input: ClaimReviewAlertInput,
): Effect.Effect<void, never, EmailService> {
  return Effect.gen(function* () {
    const emailSvc = yield* EmailService;
    yield* emailSvc.send({
      template: "vendor-claim-review-pending",
      to: input.to,
      data: {
        pending: input.summary.pending,
        oldestWaitingDays: input.summary.oldestWaitingDays,
        env: input.env,
      },
    });
    yield* Effect.sync(() => metricVendorClaimReview("operator_alerted"));
  }).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => metricVendorClaimReview("operator_alert_error")).pipe(
        Effect.andThen(
          Effect.logWarning("[claim-review] operator reminder send failed").pipe(
            Effect.annotateLogs({
              reason: "transport_error",
              template: "vendor-claim-review-pending",
            }),
          ),
        ),
      ),
    ),
  );
}
