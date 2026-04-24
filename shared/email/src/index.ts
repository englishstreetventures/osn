export { EmailService, EmailError, type EmailServiceImpl, type SendEmailInput } from "./service";

export { makeCloudflareEmailLive, type CloudflareEmailConfig } from "./cloudflare";

export { makeLogEmailLive, type RecordedEmail } from "./log";

export {
  renderTemplate,
  type EmailTemplate,
  type EmailTemplateData,
  type EmailTemplateDataMap,
  type RenderedEmail,
} from "./templates";

export {
  EMAIL_METRICS,
  metricEmailSendAttempt,
  metricEmailSendDuration,
  metricEmailRenderDuration,
  metricEmailDispatchStatus,
  classifyHttpStatus,
  type EmailOutcome,
  type EmailRenderOutcome,
  type EmailHttpStatusClass,
} from "./metrics";
