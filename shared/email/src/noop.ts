/**
 * `NoopEmailLive` — degraded-mode production transport.
 *
 * Used when a deployment is *explicitly* opted in to running WITHOUT a real
 * email provider (the `OSN_EMAIL_OPTIONAL` opt-in in `@osn/api`) and the
 * Cloudflare credentials are absent. It lets the service boot instead of
 * throwing, while making it loud and observable that transactional mail is NOT
 * being delivered.
 *
 * Crucially it is NOT `LogEmailLive`:
 *   - It DISCARDS every send — there is no in-memory ring buffer, so it can run
 *     in a long-lived production isolate without growing unbounded.
 *   - It still renders the template in-process (so a template bug surfaces as a
 *     `render_failed` rather than being silently masked in degraded mode), but
 *     it NEVER logs the rendered body, the recipient address, or the OTP code —
 *     only the bounded `template` literal and a degraded-mode marker.
 *
 * Metric `outcome` is `"skipped"`, identical to `LogEmailLive`, so dashboards
 * already distinguish non-delivered sends from real ones.
 */

import { Effect, Layer } from "effect";

import {
  metricEmailRenderDuration,
  metricEmailSendAttempt,
  metricEmailSendDuration,
} from "./metrics";
import { EmailError, EmailService, type SendEmailInput } from "./service";
import { renderTemplate } from "./templates";

/**
 * Creates a `NoopEmailLive` layer. Stateless — every call returns an equivalent
 * layer; there is nothing to capture or reset (by design — see module docs).
 */
export function makeNoopEmailLive(): Layer.Layer<EmailService> {
  return Layer.succeed(EmailService, {
    send: (input: SendEmailInput) =>
      Effect.gen(function* () {
        const started = Date.now();

        // Render to surface template bugs (matches Cloudflare/Log transports),
        // but DISCARD the result. The rendered body contains the OTP code and
        // must never be logged or retained.
        try {
          renderTemplate(input.template, input.data);
          metricEmailRenderDuration((Date.now() - started) / 1000, input.template, "ok");
        } catch (cause) {
          metricEmailRenderDuration((Date.now() - started) / 1000, input.template, "error");
          return yield* Effect.fail(new EmailError({ reason: "render_failed", cause }));
        }

        // Redacted, bounded log line. ONLY the `template` literal (already a
        // bounded union used as a metric attribute) is included — no recipient
        // address, no OTP code, no rendered subject/body. Warn-level so it is
        // visible in non-local where the default min level is `info`.
        yield* Effect.logWarning(`email suppressed (degraded mode): ${input.template}`);

        metricEmailSendAttempt(input.template, "skipped");
        metricEmailSendDuration((Date.now() - started) / 1000, input.template, "skipped");
      }).pipe(Effect.withSpan("email.send", { attributes: { template: input.template } })),
  });
}
