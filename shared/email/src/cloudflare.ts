/**
 * `CloudflareEmailLive` — production email transport.
 *
 * Renders the template in-process and POSTs directly to Cloudflare's
 * Email Service REST API. No intermediate Worker, no ARC tokens — a
 * single bearer-authed HTTPS call.
 *
 * All outbound HTTP goes through `instrumentedFetch` so the call becomes
 * a child span of `email.cloudflare.dispatch` and `traceparent` is injected
 * for cross-service trace correlation.
 */

import { instrumentedFetch } from "@shared/observability/fetch";
import { Effect, Layer } from "effect";

import {
  classifyHttpStatus,
  metricEmailDispatchStatus,
  metricEmailRenderDuration,
  metricEmailSendAttempt,
  metricEmailSendDuration,
} from "./metrics";
import { EmailError, EmailService } from "./service";
import { renderTemplate } from "./templates";

/** Runtime configuration for the Cloudflare-backed transport. */
export interface CloudflareEmailConfig {
  /** Cloudflare account ID. */
  readonly accountId: string;
  /** Cloudflare API token with Email Send permission. */
  readonly apiToken: string;
  /**
   * Sender email address (From header). Defaults to "noreply@osn.local"
   * — override in production with the verified domain address.
   */
  readonly fromAddress?: string;
}

/** Cloudflare Email Service REST API payload. */
interface CloudflareEmailPayload {
  readonly to: Array<{ readonly email: string }>;
  readonly from: { readonly email: string };
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export const makeCloudflareEmailLive = (config: CloudflareEmailConfig): Layer.Layer<EmailService> =>
  Layer.succeed(EmailService, {
    send: (input) =>
      Effect.gen(function* () {
        const started = Date.now();

        // --- render (span: email.render) ---
        const rendered = yield* Effect.try({
          try: () => renderTemplate(input.template, input.data),
          catch: (cause) => new EmailError({ reason: "render_failed", cause }),
        }).pipe(
          Effect.withSpan("email.render", { attributes: { template: input.template } }),
          Effect.tap(() =>
            Effect.sync(() =>
              metricEmailRenderDuration((Date.now() - started) / 1000, input.template, "ok"),
            ),
          ),
          Effect.tapError(() =>
            Effect.sync(() =>
              metricEmailRenderDuration((Date.now() - started) / 1000, input.template, "error"),
            ),
          ),
        );

        // --- dispatch (span: email.cloudflare.dispatch) ---
        const payload: CloudflareEmailPayload = {
          to: [{ email: input.to }],
          from: { email: config.fromAddress ?? "noreply@osn.local" },
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        };

        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email-service/send`;

        const response = yield* Effect.tryPromise({
          try: () =>
            instrumentedFetch(apiUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiToken}`,
              },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => {
            metricEmailDispatchStatus(input.template, "network");
            return new EmailError({ reason: "api_unreachable", cause });
          },
        }).pipe(
          Effect.withSpan("email.cloudflare.dispatch", {
            attributes: { template: input.template },
          }),
        );

        const statusClass = classifyHttpStatus(response.status);
        metricEmailDispatchStatus(input.template, statusClass);

        if (response.status === 429) {
          metricEmailSendAttempt(input.template, "rate_limited");
          metricEmailSendDuration((Date.now() - started) / 1000, input.template, "rate_limited");
          return yield* Effect.fail(new EmailError({ reason: "rate_limited" }));
        }

        if (!response.ok) {
          metricEmailSendAttempt(input.template, "failed");
          metricEmailSendDuration((Date.now() - started) / 1000, input.template, "failed");
          return yield* Effect.fail(
            new EmailError({ reason: "dispatch_failed", cause: { status: response.status } }),
          );
        }

        metricEmailSendAttempt(input.template, "sent");
        metricEmailSendDuration((Date.now() - started) / 1000, input.template, "sent");
      }).pipe(Effect.withSpan("email.send", { attributes: { template: input.template } })),
  });
