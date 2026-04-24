/**
 * Email template catalogue.
 *
 * Every outbound email OSN sends originates from one of these templates.
 * Adding a new outbound email requires (a) adding a `template` literal to
 * the union, (b) a typed `data` shape, and (c) a renderer. The service
 * layer's metric attribute union is kept in lockstep via a compile-time
 * check in `../metrics.ts`.
 *
 * Renderers are pure functions: they take `data`, return
 * `{ subject, text, html }`. No I/O, no DB. Worker-safe.
 */

import { renderEmailChangeOtp, renderRegistrationOtp, renderStepUpOtp } from "./otp";
import {
  renderCrossDeviceLogin,
  renderPasskeyAdded,
  renderPasskeyRemoved,
  renderRecoveryConsumed,
  renderRecoveryGenerated,
} from "./security";

/** Canonical list of templates. Keep sorted; one per outbound auth email. */
export type EmailTemplate =
  | "otp-registration"
  | "otp-step-up"
  | "otp-email-change"
  | "recovery-generated"
  | "recovery-consumed"
  | "passkey-added"
  | "passkey-removed"
  | "cross-device-login";

/** Typed data bag per template. Extend the map when adding a template. */
export interface EmailTemplateDataMap {
  "otp-registration": { code: string; ttlMinutes: number };
  "otp-step-up": { code: string; ttlMinutes: number };
  "otp-email-change": { code: string; ttlMinutes: number };
  "recovery-generated": Record<string, never>;
  "recovery-consumed": Record<string, never>;
  "passkey-added": Record<string, never>;
  "passkey-removed": Record<string, never>;
  "cross-device-login": Record<string, never>;
}

export type EmailTemplateData<T extends EmailTemplate> = EmailTemplateDataMap[T];

/** Rendered email — what the transport sends to the provider. */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Dispatches to the correct renderer. The `data` type is narrowed by the
 * `template` discriminant — the body of each branch sees a concrete
 * `EmailTemplateData<T>`.
 */
export function renderTemplate<T extends EmailTemplate>(
  template: T,
  data: EmailTemplateData<T>,
): RenderedEmail {
  switch (template) {
    case "otp-registration":
      return renderRegistrationOtp(data as EmailTemplateData<"otp-registration">);
    case "otp-step-up":
      return renderStepUpOtp(data as EmailTemplateData<"otp-step-up">);
    case "otp-email-change":
      return renderEmailChangeOtp(data as EmailTemplateData<"otp-email-change">);
    case "recovery-generated":
      return renderRecoveryGenerated();
    case "recovery-consumed":
      return renderRecoveryConsumed();
    case "passkey-added":
      return renderPasskeyAdded();
    case "passkey-removed":
      return renderPasskeyRemoved();
    case "cross-device-login":
      return renderCrossDeviceLogin();
  }
  // Exhaustive — compile error if a template is added without a branch.
  const _exhaustive: never = template;
  return _exhaustive;
}

export {
  renderRegistrationOtp,
  renderStepUpOtp,
  renderEmailChangeOtp,
  renderRecoveryGenerated,
  renderRecoveryConsumed,
  renderPasskeyAdded,
  renderPasskeyRemoved,
  renderCrossDeviceLogin,
};
