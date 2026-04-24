/**
 * Email service — transactional-only sender for OSN auth flows.
 *
 * The service is an Effect `Context.Tag`; callers yield it and invoke
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
 */
export class EmailError extends Data.TaggedError("EmailError")<{
  readonly reason: "dispatch_failed" | "rate_limited" | "api_unreachable" | "render_failed";
  readonly cause?: unknown;
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
}

export class EmailService extends Context.Tag("@shared/email/EmailService")<
  EmailService,
  EmailServiceImpl
>() {}
