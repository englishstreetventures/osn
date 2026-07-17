/**
 * Fail-soft vendor claim-invite email.
 *
 * When an organiser seeds a directory listing for a vendor, cire best-effort
 * emails the vendor a link so they can claim their listing. The claim URL is
 * returned to the organiser separately (Task 7), so this email is a
 * nice-to-have — a broken or absent transport must NEVER fail the caller.
 *
 * Error channel is `never`: any `EmailError` or defect is caught, a warning
 * is logged, and the effect resolves to `void`.
 */

import { EmailService } from "@shared/email";
import { Effect } from "effect";

export interface ClaimInviteEmailInput {
  /** Vendor's email address. */
  readonly to: string;
  /** The full claim URL the vendor follows to take ownership of their listing. */
  readonly claimUrl: string;
  /** Vendor's display name for the greeting (may be empty string). */
  readonly vendorName: string;
}

/**
 * Best-effort email to a vendor with their listing claim link.
 *
 * Requires `EmailService` in the Effect context. Swallows all errors —
 * success type is `void`, error channel is `never`.
 */
export function sendClaimInviteEmail(
  input: ClaimInviteEmailInput,
): Effect.Effect<void, never, EmailService> {
  return Effect.gen(function* () {
    const emailSvc = yield* EmailService;
    yield* emailSvc.send({
      template: "vendor-claim-invite",
      to: input.to,
      data: { claimUrl: input.claimUrl, vendorName: input.vendorName },
    });
  }).pipe(
    Effect.catchAllCause(() =>
      Effect.logWarning("[vendor-email] claim-invite send failed — continuing without email").pipe(
        Effect.annotateLogs({ reason: "transport_error", template: "vendor-claim-invite" }),
      ),
    ),
  );
}
