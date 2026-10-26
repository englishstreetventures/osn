/**
 * `ResendEmailLive` — production email transport (Resend HTTP API).
 *
 * Renders the template in-process and POSTs directly to Resend's REST API
 * (`https://api.resend.com/emails`, or a local emulator named by `apiUrl`). A
 * single bearer-authed call — works on workerd (no SMTP, no paid Workers plan),
 * unlike the Cloudflare Email Service transport.
 *
 * The render path, instrumented fetch, metrics and the non-2xx → tagged-failure
 * semantics match `cloudflare.ts`, so the two transports are interchangeable
 * behind the `EmailService` Tag. Neither sets a timeout; a caller that must not
 * wait wraps the send in its own.
 *
 * Unlike `cloudflare.ts`, this transport logs every failed dispatch, because
 * on a deployed Worker that line is the only record of why mail did not go: the
 * metrics export nothing there, and most callers swallow the failure. See
 * {@link logDispatchFailure} for what the line holds.
 *
 * All outbound HTTP goes through `instrumentedFetch` so the call becomes a
 * child span of `email.resend.dispatch` and `traceparent` is injected for
 * cross-service trace correlation.
 *
 * SECURITY: the Resend API key is a bearer secret. It is only ever placed in
 * the `Authorization` header — never in the URL, never in span/metric
 * attributes or log annotations, never in an `EmailError.cause`. No code path
 * logs or returns it.
 *
 * The destination comes from deployment config only, never from request input,
 * so there is no SSRF surface. An `apiUrl` override can name only a loopback
 * origin (see {@link resendApiUrlProblem}): a loopback literal, or a
 * `*.localhost` name over https, where TLS refuses any host a resolver
 * wrongly sends it to. So a misconfigured Worker cannot send the key or any
 * mail to another host.
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
import { type RenderedEmail, renderTemplate } from "./templates";

/** Resend's API origin, used whenever `apiUrl` is unset or blank. */
const DEFAULT_RESEND_API_URL = "https://api.resend.com";

/** The loopback addresses, and `localhost`, which hosts files map to them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `raw` cannot be the Resend API origin, or `null` when it can. An override
 * exists for local emulation only, so it must be a loopback origin with no
 * credentials, path, query or fragment: `localhost`, `127.0.0.1` or `[::1]`
 * over http or https, or a `*.localhost` name over https only. A resolver
 * decides where a `*.localhost` name goes, and only a certificate check stops a
 * wrong answer from receiving the key. The answer never repeats `raw`, which
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
  const named = url.hostname.endsWith(".localhost");
  if (!LOOPBACK_HOSTS.has(url.hostname) && !named) {
    return "must name a loopback host (localhost, 127.0.0.1, [::1], or a *.localhost name over https)";
  }
  if (named && url.protocol !== "https:") {
    return "must use https for a *.localhost name, which a resolver could send elsewhere";
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

/** The most of an error body read for its code. Resend's are a few hundred bytes. */
const MAX_ERROR_BODY = 4096;

/**
 * A Resend error code as logged. Lower case and underscores only, so a value
 * that passes can hold no address, host or message text.
 */
const RESEND_ERROR_CODE = /^[a-z][a-z_]{0,63}$/;

/**
 * The `validation_error` messages an operator has to tell apart, each read into
 * a fixed code. Resend sends the same code and status for both, and only the
 * message says which; the message itself can name an address, so it is never
 * logged.
 */
const RESEND_DETAILS: ReadonlyArray<readonly [RegExp, string]> = [
  [/domain is not verified/i, "domain_not_verified"],
  [/only send testing emails/i, "testing_recipients_only"],
];

/**
 * What a refusal's body says, in fixed codes only. A key is present only when
 * its value is, so the type can be annotated onto a log line as it stands.
 */
type ResendRefusal = {
  resendError?: string;
  resendDetail?: string;
};

function readRefusal(text: string): ResendRefusal {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null) return {};
  const { name, message } = body as { readonly name?: unknown; readonly message?: unknown };
  const code = typeof name === "string" ? name.toLowerCase() : "";
  const detail =
    typeof message === "string"
      ? RESEND_DETAILS.find(([pattern]) => pattern.test(message))?.[1]
      : undefined;
  const refusal: ResendRefusal = {};
  if (RESEND_ERROR_CODE.test(code)) refusal.resendError = code;
  if (detail !== undefined) refusal.resendDetail = detail;
  return refusal;
}

/**
 * The first {@link MAX_ERROR_BODY} bytes of `body`, as text. Stops reading
 * there, and lets the stream go once done or once `signal` aborts, so neither a
 * long body nor a stalled one keeps the response open.
 */
async function readCapped(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const release = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", release, { once: true });
  const bytes = new Uint8Array(MAX_ERROR_BODY);
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY) {
      // A stream gives its chunks one read at a time; each read waits on the last.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      const taken = value.subarray(0, MAX_ERROR_BODY - size);
      bytes.set(taken, size);
      size += taken.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
  return new TextDecoder().decode(bytes.subarray(0, size));
}

/**
 * Read a refusal's body, bounded in size and time: a body that declares more
 * than {@link MAX_ERROR_BODY} bytes is not read at all, one that does not is
 * read no further than that, and the read gives up after two seconds. Anything
 * that goes wrong reading it — too large, too slow, not JSON — leaves the codes
 * out; it never changes the send's own failure.
 */
const refusalOf = (response: Response): Effect.Effect<ResendRefusal> => {
  const body = response.body;
  if (body === null) return Effect.succeed({});
  if (Number(response.headers.get("content-length")) > MAX_ERROR_BODY) {
    void body.cancel().catch(() => undefined);
    return Effect.succeed({});
  }
  return Effect.tryPromise((signal) => readCapped(body, signal)).pipe(
    Effect.timeout("2 seconds"),
    Effect.map(readRefusal),
    Effect.catch(() => Effect.succeed({})),
  );
};

/**
 * One failed dispatch, as logged: a template name, fixed codes and numbers. A
 * caller leaves out a key it has no value for rather than setting it
 * `undefined`, which a logger would print.
 */
type DispatchFailure = ResendRefusal & {
  template: string;
  reason: EmailError["reason"];
  status?: number;
  /** Emails in the batch call that failed; absent for a single send. */
  size?: number;
};

/**
 * Log one failed dispatch: the template, the failure's reason, the HTTP status,
 * and Resend's error code and detail when the body gave them.
 *
 * Every field is a template name, a fixed code or a number. No recipient, no
 * message text, no body, no key and no fetch error text is ever annotated, so
 * the line is safe under any logger — including Effect's default one, which a
 * caller that provides no redacting logger gets.
 */
const logDispatchFailure = (failure: DispatchFailure): Effect.Effect<void> =>
  Effect.logError("email.dispatch_failed").pipe(Effect.annotateLogs(failure));

/** A send a caller cut off, as logged. */
type DispatchInterrupted = {
  template: string;
  /** Present once Resend had answered. */
  status?: number;
};

/**
 * Log a send that a caller interrupted — almost always its own timeout — with
 * the status when Resend had already answered.
 */
const logDispatchInterrupted = (
  template: string,
  status: number | undefined,
): Effect.Effect<void> => {
  const fields: DispatchInterrupted = { template };
  if (status !== undefined) fields.status = status;
  return Effect.logWarning("email.dispatch_interrupted").pipe(Effect.annotateLogs(fields));
};

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
    // One render per distinct data object. The output depends only on the
    // template and the data, and a caller mailing one record to several
    // recipients (cire's gift summary, to each owner) passes the same object.
    const renderedOnce = new Map<unknown, { template: string; rendered: RenderedEmail }>();
    for (const input of inputs) {
      const hit = renderedOnce.get(input.data);
      const rendered =
        hit && hit.template === input.template
          ? hit.rendered
          : yield* Effect.try({
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
              Effect.tapError(() =>
                logDispatchFailure({
                  template: input.template,
                  reason: "render_failed",
                  size: inputs.length,
                }),
              ),
            );
      renderedOnce.set(input.data, { template: input.template, rendered });
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
        // The signal aborts the request when a caller's timeout interrupts.
        try: (signal) =>
          instrumentedFetch(batchUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Bearer secret — header only. Never logged or echoed.
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(chunk),
            signal,
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
        Effect.tapError(() =>
          logDispatchFailure({ template, reason: "api_unreachable", size: chunk.length }),
        ),
      );

      metricEmailDispatchStatus(template, classifyHttpStatus(response.status));
      if (response.status === 429) {
        for (const i of indexes) record(i, "rate_limited");
        yield* logDispatchFailure({
          template,
          reason: "rate_limited",
          status: response.status,
          size: chunk.length,
          ...(yield* refusalOf(response)),
        });
        return yield* Effect.fail(new EmailError({ reason: "rate_limited" }));
      }
      if (!response.ok) {
        for (const i of indexes) record(i, "failed");
        yield* logDispatchFailure({
          template,
          reason: "dispatch_failed",
          status: response.status,
          size: chunk.length,
          ...(yield* refusalOf(response)),
        });
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
      Effect.suspend(() => {
        // Set once Resend answers, so a send interrupted while its error body
        // is being read still logs the status.
        let status: number | undefined;
        return Effect.gen(function* () {
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
            Effect.tapError(() =>
              logDispatchFailure({ template: input.template, reason: "render_failed" }),
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
            // The signal aborts the request when a caller's timeout interrupts:
            // the wait ends and the connection is freed. A request Resend has
            // already received may still be delivered.
            try: (signal) =>
              instrumentedFetch(sendUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  // Bearer secret — header only. Never logged or echoed.
                  Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(payload),
                signal,
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
            Effect.tapError(() =>
              logDispatchFailure({ template: input.template, reason: "api_unreachable" }),
            ),
          );
          status = response.status;

          const statusClass = classifyHttpStatus(response.status);
          metricEmailDispatchStatus(input.template, statusClass);

          if (response.status === 429) {
            metricEmailSendAttempt(input.template, "rate_limited");
            metricEmailSendDuration((Date.now() - started) / 1000, input.template, "rate_limited");
            yield* logDispatchFailure({
              template: input.template,
              reason: "rate_limited",
              status: response.status,
              ...(yield* refusalOf(response)),
            });
            return yield* Effect.fail(new EmailError({ reason: "rate_limited" }));
          }

          if (!response.ok) {
            metricEmailSendAttempt(input.template, "failed");
            metricEmailSendDuration((Date.now() - started) / 1000, input.template, "failed");
            yield* logDispatchFailure({
              template: input.template,
              reason: "dispatch_failed",
              status: response.status,
              ...(yield* refusalOf(response)),
            });
            // The error carries only the status code — never the body or the key.
            return yield* Effect.fail(
              new EmailError({ reason: "dispatch_failed", cause: { status: response.status } }),
            );
          }

          metricEmailSendAttempt(input.template, "sent");
          metricEmailSendDuration((Date.now() - started) / 1000, input.template, "sent");
        }).pipe(
          Effect.onInterrupt(() => logDispatchInterrupted(input.template, status)),
          Effect.withSpan("email.send", { attributes: { template: input.template } }),
        );
      }),
  });
};
