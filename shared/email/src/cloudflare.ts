/**
 * `CloudflareEmailLive` — the fallback email transport, for a deployment with
 * Cloudflare Email Sending credentials and no Resend key.
 *
 * Renders the template in-process and POSTs directly to Cloudflare's Email
 * Sending REST API (`POST /accounts/{account_id}/email/sending/send`). No
 * intermediate Worker, no ARC tokens — a single bearer-authed HTTPS call. The
 * request follows Cloudflare's documented body: `to` and `from` are address
 * objects, `{ address, name? }`.
 *
 * The configured sender is read when the layer is built, and a malformed one
 * throws then, never at a send. See {@link cloudflareSenderProblem} for the
 * forms it takes.
 *
 * On Workers, Cloudflare traces the POST as a `fetch` span in the request's
 * trace, beside the `email.cloudflare.dispatch` span. The call carries no
 * trace context: Workers do not propagate it.
 */

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
  /** Cloudflare API token with the `Email Sending Write` permission. */
  readonly apiToken: string;
  /**
   * The sender (From header): a bare address, or a display name and an address
   * in angle brackets (`Musubi <hello@musubi.social>`). Defaults to
   * "noreply@osn.local"; a deployment sets an address on a domain onboarded to
   * Cloudflare Email Sending. A malformed value makes
   * {@link makeCloudflareEmailLive} throw.
   */
  readonly fromAddress?: string;
}

/** An address as the Email Sending REST API takes it; `name` only when there is one. */
interface CloudflareAddress {
  readonly address: string;
  readonly name?: string;
}

/** Cloudflare Email Sending REST API payload. */
interface CloudflareEmailPayload {
  readonly to: CloudflareAddress;
  readonly from: CloudflareAddress;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** RFC 5322 `atext`: what a dot-atom local part is made of. */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";

/** One hostname label: 1-63 letters, digits or inner hyphens. */
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

/** A dot-atom local part, `@`, and a hostname of two or more labels. */
const ADDRESS = new RegExp(`^${ATEXT}+(?:\\.${ATEXT}+)*@${LABEL}(?:\\.${LABEL})+$`);

/** RFC 5321's limits: 64 characters of local part, 254 in the whole address. */
const MAX_LOCAL_PART = 64;
const MAX_ADDRESS = 254;

/**
 * A character no sender may hold: a control character (a line break would end
 * the header), a format character (a bidi override or zero-width mark changes
 * what the reader sees), or a line or paragraph separator.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** `"quoted name" <address>`: any character but `"` and `\`, or `\` and a printable ASCII one. */
const QUOTED_NAME = /^"((?:[^"\\]|\\[ -~])*)"\s*<([^<>]*)>$/;

/** `unquoted name <address>`: a name with none of the specials that would make it ambiguous. */
const UNQUOTED_NAME = /^([^"<>[\]:;@\\,]*)<([^<>]*)>$/;

const NOT_A_SENDER =
  "must be an address, or a display name followed by an address in angle brackets";

type SenderReading =
  | { readonly sender: CloudflareAddress; readonly problem?: undefined }
  | { readonly problem: string };

function readAddress(address: string, name: string): SenderReading {
  if (!ADDRESS.test(address)) return { problem: NOT_A_SENDER };
  if (address.length > MAX_ADDRESS || address.indexOf("@") > MAX_LOCAL_PART) {
    return {
      problem: "has an address longer than 254 characters or a local part longer than 64",
    };
  }
  const trimmed = name.trim();
  return { sender: trimmed === "" ? { address } : { address, name: trimmed } };
}

function readSender(raw: string): SenderReading {
  const value = raw.trim();
  if (value === "") return { problem: "is empty" };
  if (UNSAFE.test(value)) {
    return { problem: "contains a control, format or line-separator character" };
  }
  if (!value.includes("<")) return readAddress(value, "");
  const quoted = QUOTED_NAME.exec(value);
  if (quoted) {
    const [, name = "", address = ""] = quoted;
    return readAddress(address, name.replace(/\\(.)/g, "$1"));
  }
  const unquoted = UNQUOTED_NAME.exec(value);
  if (unquoted) {
    const [, name = "", address = ""] = unquoted;
    return readAddress(address, name);
  }
  return { problem: NOT_A_SENDER };
}

/**
 * Why `raw` cannot be this transport's sender, or `null` when it can. It takes
 * a bare address (`hello@musubi.social`), an address in angle brackets, or a
 * display name before one: unquoted (`Musubi (dev) <dev@musubi.social>`) with
 * none of `" < > [ ] : ; @ \ ,`, or quoted (`"Musubi, Inc." <hello@musubi.social>`)
 * with `\"` and `\\` for a quote and a backslash. Surrounding whitespace is
 * ignored. The address is a dot-atom local part of at most 64 characters, `@`
 * and a hostname of two or more labels, 254 characters in all. No control,
 * format or line-separator character anywhere. The answer never repeats `raw`.
 */
export function cloudflareSenderProblem(raw: string): string | null {
  return readSender(raw).problem ?? null;
}

export const makeCloudflareEmailLive = (
  config: CloudflareEmailConfig,
): Layer.Layer<EmailService> => {
  const reading = readSender(config.fromAddress ?? "noreply@osn.local");
  if (reading.problem !== undefined) {
    throw new Error(`Cloudflare email sender ${reading.problem}`);
  }
  const from = reading.sender;
  return Layer.succeed(EmailService, {
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
          to: { address: input.to },
          from,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        };

        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`;

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(apiUrl, {
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
};
