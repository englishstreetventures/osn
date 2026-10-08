/**
 * `ResendEmailLive` — production email transport (Resend HTTP API).
 *
 * Renders the template in-process and POSTs directly to Resend's REST API
 * (`https://api.resend.com/emails`, or a local emulator named by `apiUrl`). A
 * single bearer-authed call — works on workerd (no SMTP, no paid Workers plan),
 * unlike the Cloudflare Email Service transport.
 *
 * Behaviour (render path, instrumented fetch, timeout, metrics, and the
 * non-2xx → tagged-failure semantics) mirrors `cloudflare.ts` exactly so the
 * two transports are interchangeable behind the `EmailService` Tag.
 *
 * All outbound HTTP goes through `instrumentedFetch` so the call becomes a
 * child span of `email.resend.dispatch` and `traceparent` is injected for
 * cross-service trace correlation.
 *
 * SECURITY: the Resend API key is a bearer secret. It is only ever placed in
 * the `Authorization` header — never in the URL, never in span/metric
 * attributes, never in an `EmailError.cause`. No code path logs or returns it.
 *
 * The destination comes from deployment config only, never from request input,
 * so there is no SSRF surface. An `apiUrl` override can name only a loopback
 * origin (see {@link resendApiUrlProblem}), so a misconfigured Worker cannot
 * send the key or any mail to another host.
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
import { EmailError, EmailService, type SendEmailInput } from "./service";
import { renderTemplate } from "./templates";

/** Resend's API origin, used whenever `apiUrl` is unset or blank. */
const DEFAULT_RESEND_API_URL = "https://api.resend.com";

/** Host names that resolve to this machine, and only to it. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `raw` cannot be the Resend API origin, or `null` when it can. An override
 * exists for local emulation only, so it must be a loopback origin: `localhost`,
 * a `*.localhost` name, `127.0.0.1` or `[::1]`, over http or https, with no
 * credentials, path, query or fragment. The answer never repeats `raw`, which
 * could carry credentials.
 */
export function resendApiUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be an http or https URL";
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && !url.hostname.endsWith(".localhost")) {
    return "must name a loopback host (localhost, *.localhost, 127.0.0.1 or [::1])";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not carry credentials";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return "must be an origin, with no path, query or fragment";
  }
  return null;
}

/** The origin to send to: the default when `apiUrl` is unset or blank. */
function resolveApiOrigin(apiUrl: string | undefined): string {
  const raw = apiUrl?.trim();
  if (!raw) return DEFAULT_RESEND_API_URL;
  const problem = resendApiUrlProblem(raw);
  if (problem !== null) throw new Error(`Resend apiUrl ${problem}`);
  return new URL(raw).origin;
}

/** Resend accepts at most this many emails in one batch call. */
export const RESEND_BATCH_LIMIT = 100;

/** Runtime configuration for the Resend-backed transport. */
export interface ResendEmailConfig {
  /** Resend API key (bearer). NEVER logged, returned, or placed in a URL. */
  readonly apiKey: string;
  /**
   * Sender email address (From header). Defaults to "noreply@osn.local"
   * — override in production with the verified domain address.
   */
  readonly fromAddress?: string;
  /**
   * API origin. Unset or blank ⇒ `https://api.resend.com`. Set only to point at
   * a local emulator; anything but a loopback origin makes
   * {@link makeResendEmailLive} throw.
   */
  readonly apiUrl?: string;
}

/** Resend `POST /emails` request payload. */
interface ResendEmailPayload {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly html?: string;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Render every email, then POST them to the batch endpoint, at most
 * {@link RESEND_BATCH_LIMIT} per call, one call after another. A render failure
 * fails the batch before anything is sent; a failed call fails it too, though
 * calls before it have gone — callers that must not double-send keep a batch
 * within one call.
 */
const sendBatch = (
  config: ResendEmailConfig,
  batchUrl: string,
  inputs: readonly SendEmailInput[],
): Effect.Effect<void, EmailError> =>
  Effect.gen(function* () {
    if (inputs.length === 0) return;
    const started = Date.now();
    const from = config.fromAddress ?? "noreply@osn.local";

    const payloads: ResendEmailPayload[] = [];
    for (const input of inputs) {
      const rendered = yield* Effect.try({
        try: () => renderTemplate(input.template, input.data),
        catch: (cause) => new EmailError({ reason: "render_failed", cause }),
      }).pipe(
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
      payloads.push({
        from,
        to: [input.to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: rendered.headers,
      });
    }

    const record = (index: number, outcome: "sent" | "failed" | "rate_limited") => {
      const template = inputs[index]!.template;
      metricEmailSendAttempt(template, outcome);
      metricEmailSendDuration((Date.now() - started) / 1000, template, outcome);
    };

    for (let offset = 0; offset < payloads.length; offset += RESEND_BATCH_LIMIT) {
      const chunk = payloads.slice(offset, offset + RESEND_BATCH_LIMIT);
      const indexes = chunk.map((_, i) => offset + i);
      const template = inputs[offset]!.template;
      const response = yield* Effect.tryPromise({
        try: () =>
          instrumentedFetch(batchUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Bearer secret — header only. Never logged or echoed.
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(chunk),
          }),
        catch: (cause) => {
          metricEmailDispatchStatus(template, "network");
          for (const i of indexes) record(i, "failed");
          return new EmailError({ reason: "api_unreachable", cause });
        },
      }).pipe(
        Effect.withSpan("email.resend.dispatch_batch", {
          attributes: { template, size: chunk.length },
        }),
      );

      metricEmailDispatchStatus(template, classifyHttpStatus(response.status));
      if (response.status === 429) {
        for (const i of indexes) record(i, "rate_limited");
        return yield* Effect.fail(new EmailError({ reason: "rate_limited" }));
      }
      if (!response.ok) {
        for (const i of indexes) record(i, "failed");
        return yield* Effect.fail(
          new EmailError({ reason: "dispatch_failed", cause: { status: response.status } }),
        );
      }
      for (const i of indexes) record(i, "sent");
    }
  }).pipe(Effect.withSpan("email.send_batch", { attributes: { size: inputs.length } }));

/**
 * The Resend transport. Throws when `config.apiUrl` is set to anything
 * {@link resendApiUrlProblem} refuses, so a bad override fails at boot rather
 * than on the first send.
 */
export const makeResendEmailLive = (config: ResendEmailConfig): Layer.Layer<EmailService> => {
  const origin = resolveApiOrigin(config.apiUrl);
  const sendUrl = `${origin}/emails`;
  const batchUrl = `${origin}/emails/batch`;
  return Layer.succeed(EmailService, {
    sendBatch: (inputs) => sendBatch(config, batchUrl, inputs),
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

        // --- dispatch (span: email.resend.dispatch) ---
        const payload: ResendEmailPayload = {
          from: config.fromAddress ?? "noreply@osn.local",
          to: [input.to],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: rendered.headers,
        };

        const response = yield* Effect.tryPromise({
          try: () =>
            instrumentedFetch(sendUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                // Bearer secret — header only. Never logged or echoed.
                Authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => {
            metricEmailDispatchStatus(input.template, "network");
            // `cause` is the fetch rejection (network error) — never the key.
            return new EmailError({ reason: "api_unreachable", cause });
          },
        }).pipe(
          Effect.withSpan("email.resend.dispatch", {
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
          // Surface only the status code — never the response body or the key.
          return yield* Effect.fail(
            new EmailError({ reason: "dispatch_failed", cause: { status: response.status } }),
          );
        }

        metricEmailSendAttempt(input.template, "sent");
        metricEmailSendDuration((Date.now() - started) / 1000, input.template, "sent");
      }).pipe(Effect.withSpan("email.send", { attributes: { template: input.template } })),
  });
};
