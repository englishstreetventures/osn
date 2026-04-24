/**
 * Email service metrics — transactional-email observability.
 *
 * Single source of truth for email metric names and typed recorders.
 * Every attribute is a bounded string-literal union; recipient address,
 * account ID, request ID are intentionally absent. Cardinality ceiling:
 * 7 templates × 4 outcomes = 28 series on the main counter.
 */

import {
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
} from "@shared/observability/metrics";

import type { EmailTemplate } from "./templates";

/** Canonical metric names. Grep-able + refactor-safe. */
export const EMAIL_METRICS = {
  sendAttempts: "osn.email.send.attempts",
  sendDuration: "osn.email.send.duration",
  renderDuration: "osn.email.render.duration",
  dispatchStatus: "osn.email.dispatch.http_status",
} as const;

/** Dispatch outcome attribute. Must stay a bounded union. */
export type EmailOutcome = "sent" | "failed" | "rate_limited" | "skipped";

/** Render outcome attribute (separate from dispatch since render is local). */
export type EmailRenderOutcome = "ok" | "error";

/**
 * HTTP status class bucket for the outbound call to the Cloudflare Email API.
 * Keeps cardinality fixed regardless of provider-specific status codes.
 */
export type EmailHttpStatusClass = "2xx" | "4xx" | "5xx" | "network";

type SendAttemptAttrs = { template: EmailTemplate; outcome: EmailOutcome };
type SendDurationAttrs = { template: EmailTemplate; outcome: EmailOutcome };
type RenderDurationAttrs = { template: EmailTemplate; outcome: EmailRenderOutcome };
type DispatchStatusAttrs = { template: EmailTemplate; status_class: EmailHttpStatusClass };

const sendAttemptsCounter = createCounter<SendAttemptAttrs>({
  name: EMAIL_METRICS.sendAttempts,
  description: "Transactional email send attempts by template and outcome",
  unit: "{attempt}",
});

const sendDurationHistogram = createHistogram<SendDurationAttrs>({
  name: EMAIL_METRICS.sendDuration,
  description: "End-to-end duration of an email send call (render + dispatch)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const renderDurationHistogram = createHistogram<RenderDurationAttrs>({
  name: EMAIL_METRICS.renderDuration,
  description: "Template rendering duration (in-process, no I/O)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const dispatchStatusCounter = createCounter<DispatchStatusAttrs>({
  name: EMAIL_METRICS.dispatchStatus,
  description: "Cloudflare Email API HTTP response class on email dispatch",
  unit: "{response}",
});

// ---------------------------------------------------------------------------
// Public recording helpers — the ONLY way email code should emit metrics.
// ---------------------------------------------------------------------------

export const metricEmailSendAttempt = (template: EmailTemplate, outcome: EmailOutcome): void =>
  sendAttemptsCounter.inc({ template, outcome });

export const metricEmailSendDuration = (
  seconds: number,
  template: EmailTemplate,
  outcome: EmailOutcome,
): void => sendDurationHistogram.record(seconds, { template, outcome });

export const metricEmailRenderDuration = (
  seconds: number,
  template: EmailTemplate,
  outcome: EmailRenderOutcome,
): void => renderDurationHistogram.record(seconds, { template, outcome });

export const metricEmailDispatchStatus = (
  template: EmailTemplate,
  statusClass: EmailHttpStatusClass,
): void => dispatchStatusCounter.inc({ template, status_class: statusClass });

/** Maps an HTTP status code to the bounded status-class attribute. */
export const classifyHttpStatus = (status: number): EmailHttpStatusClass => {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "network";
};
