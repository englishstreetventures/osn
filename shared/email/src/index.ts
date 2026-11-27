export {
  EmailService,
  EmailError,
  type EmailServiceImpl,
  type KeyedBatchResult,
  type SendEmailInput,
} from "./service";

export {
  makeCloudflareEmailLive,
  cloudflareSenderProblem,
  type CloudflareEmailConfig,
} from "./cloudflare";

export { makeResendEmailLive, resendApiUrlProblem, type ResendEmailConfig } from "./resend";

export { makeLogEmailLive, type LogEmailTransport, type RecordedEmail } from "./log";

export { makeNoopEmailLive } from "./noop";

export {
  renderTemplate,
  type ChangeNoticeData,
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
