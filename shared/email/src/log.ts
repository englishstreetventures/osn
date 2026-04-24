/**
 * `LogEmailLive` — dev + test transport.
 *
 * Does not open any network connection. Instead it:
 *   1. Renders the template in-process (so template bugs still surface),
 *   2. Records the rendered email into an in-memory ring buffer
 *      (`recorded()` — used by tests to assert on payloads),
 *   3. Emits a single `Effect.logDebug` line with `template`, `to`, and
 *      the rendered `subject`. The full body is NOT logged — the
 *      redacting logger would scrub OTPs but we avoid the temptation by
 *      not emitting them in the first place.
 *
 * Metric `outcome` is `"skipped"` — dashboards should distinguish
 * dev/test sends from production sends.
 */

import { Effect, Layer } from "effect";

import {
  metricEmailRenderDuration,
  metricEmailSendAttempt,
  metricEmailSendDuration,
} from "./metrics";
import { EmailError, EmailService, type SendEmailInput } from "./service";
import { renderTemplate, type RenderedEmail, type EmailTemplate } from "./templates";

/** A captured send. Exposed via `recordedEmails` for unit tests. */
export interface RecordedEmail {
  readonly template: EmailTemplate;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly at: number;
}

const MAX_RECORD = 256;

/**
 * Creates a fresh `LogEmailLive` layer with its own in-memory recorder.
 * Each call returns an isolated `{ layer, recorded, reset }` — use a new
 * one per test so captured payloads from one test don't bleed into the
 * next.
 */
export function makeLogEmailLive(): {
  readonly layer: Layer.Layer<EmailService>;
  readonly recorded: () => readonly RecordedEmail[];
  readonly reset: () => void;
} {
  const ring: RecordedEmail[] = [];

  const layer = Layer.succeed(EmailService, {
    send: (input: SendEmailInput) =>
      Effect.gen(function* () {
        const started = Date.now();

        let rendered: RenderedEmail;
        try {
          rendered = renderTemplate(input.template, input.data);
          metricEmailRenderDuration((Date.now() - started) / 1000, input.template, "ok");
        } catch (cause) {
          metricEmailRenderDuration((Date.now() - started) / 1000, input.template, "error");
          return yield* Effect.fail(new EmailError({ reason: "render_failed", cause }));
        }

        if (ring.length >= MAX_RECORD) ring.shift();
        ring.push({
          template: input.template,
          to: input.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          at: Date.now(),
        });

        // Debug-level log with bounded fields only — no OTP code, no full
        // body. Guarded by log-level config in production; the
        // redacting logger also scrubs `email` / `to` if they leak into
        // annotations, but we're passing them in the message string on
        // purpose for local-dev operator visibility.
        yield* Effect.logDebug(
          `[email:log] template=${input.template} subject="${rendered.subject}" to=${input.to}`,
        );

        metricEmailSendAttempt(input.template, "skipped");
        metricEmailSendDuration((Date.now() - started) / 1000, input.template, "skipped");
      }).pipe(Effect.withSpan("email.send", { attributes: { template: input.template } })),
  });

  return {
    layer,
    recorded: () => ring.slice(),
    reset: () => {
      ring.length = 0;
    },
  };
}
