/**
 * Email service — transactional-only sender for OSN auth flows.
 *
 * The service is an Effect `Context.Service` key; callers yield it and invoke
 * `send({ template, to, data })`. Actual dispatch is determined by the
 * concrete `Layer` provided at boot: `CloudflareEmailLive` in production
 * staging, `LogEmailLive` in local dev + unit tests.
 *
 * Rendering happens inside the service (template enum + typed `data`
 * object), not at call sites — this keeps subject/body strings out of the
 * business-logic code and makes auditing the complete set of emails the
 * platform sends trivial.
 */

import { Context, Data, type Effect } from "effect";

import type { EmailTemplate, EmailTemplateData } from "./templates";

/**
 * Tagged error class for email dispatch failures. `reason` is the only
 * field dashboards should slice by; keep it a bounded literal union.
 *
 * `status` and `providerError` are set when the provider answered: its HTTP
 * status, and its error name when that is a lower-case code (Resend's
 * `invalid_idempotent_request`, `daily_quota_exceeded`, …). Neither ever holds
 * an address, message text or key, so a caller may branch on them and log them.
 */
export class EmailError extends Data.TaggedError("EmailError")<{
  readonly reason: "dispatch_failed" | "rate_limited" | "api_unreachable" | "render_failed";
  readonly cause?: unknown;
  readonly status?: number;
  readonly providerError?: string;
}> {}

/**
 * Input to `EmailService.send`. `template` picks the renderer; `data` is
 * the typed parameter bag for that template (compile-time checked via the
 * discriminated union in `./templates`).
 */
export type SendEmailInput = {
  readonly [T in EmailTemplate]: {
    readonly template: T;
    readonly to: string;
    readonly data: EmailTemplateData<T>;
  };
}[EmailTemplate];

export interface EmailServiceImpl {
  readonly send: (input: SendEmailInput) => Effect.Effect<void, EmailError>;
  /**
   * Send several emails in as few provider calls as the transport allows —
   * one per 100 on Resend. All or nothing as far as the caller can tell: a
   * failure means none of the batch should be counted as sent. Optional: a
   * transport without it leaves the caller to loop over {@link send}.
   */
  readonly sendBatch?: (inputs: readonly SendEmailInput[]) => Effect.Effect<void, EmailError>;
  /**
   * Send one batch of at most 100 in ONE provider call, under `idempotencyKey`:
   * the provider sends nothing twice for one key (Resend keeps a key 24 hours),
   * so a caller that did not learn a call's outcome sends the same batch again
   * under the same key. More than 100 fails before any request. Addresses the
   * provider refuses on their own are counted in `refused` and the rest still
   * go. Optional: only a transport with keyed batches has it.
   */
  readonly sendKeyedBatch?: (
    inputs: readonly SendEmailInput[],
    options: { readonly idempotencyKey: string },
  ) => Effect.Effect<KeyedBatchResult, EmailError>;
}

/** What one keyed batch did: addresses the provider accepted, and those it refused on their own. */
export interface KeyedBatchResult {
  readonly accepted: number;
  readonly refused: number;
}

export class EmailService extends Context.Service<EmailService, EmailServiceImpl>()(
  "@shared/email/EmailService",
) {}
