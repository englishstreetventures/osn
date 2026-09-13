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

import {
  renderEnquiryNew,
  renderEnquiryReply,
  renderEnquiryQuote,
  type EnquiryNewData,
  type EnquiryReplyData,
  type EnquiryQuoteData,
} from "./enquiry";
import { renderRegistryGiftSummary, type RegistryGiftSummaryData } from "./gift-summary";
import {
  renderEmailChangeOtp,
  renderRecoveryOtp,
  renderRegistrationOtp,
  renderStepUpOtp,
} from "./otp";
import {
  type RecoveryUsedData,
  renderCrossDeviceLogin,
  renderPasskeyAdded,
  renderPasskeyRemoved,
  renderRecoveryConsumed,
  renderRecoveryGenerated,
  renderRecoveryUsed,
  renderTotpDisabled,
  renderTotpEnrolled,
} from "./security";
import { renderVendorClaimInvite, type VendorClaimInviteData } from "./vendor-claim";

/** Canonical list of templates. Keep sorted; one per outbound auth email. */
export type EmailTemplate =
  | "enquiry-new"
  | "enquiry-reply"
  | "enquiry-quote"
  | "otp-registration"
  | "otp-step-up"
  | "otp-email-change"
  | "otp-recovery"
  | "recovery-generated"
  | "recovery-consumed"
  | "recovery-used"
  | "passkey-added"
  | "passkey-removed"
  | "totp-enrolled"
  | "totp-disabled"
  | "cross-device-login"
  | "registry-gift-summary"
  | "vendor-claim-invite";

/** Typed data bag per template. Extend the map when adding a template. */
export interface EmailTemplateDataMap {
  "enquiry-new": EnquiryNewData;
  "enquiry-reply": EnquiryReplyData;
  "enquiry-quote": EnquiryQuoteData;
  "otp-registration": { code: string; ttlMinutes: number };
  "otp-step-up": { code: string; ttlMinutes: number };
  "otp-email-change": { code: string; ttlMinutes: number };
  "otp-recovery": { code: string; ttlMinutes: number };
  "recovery-generated": Record<string, never>;
  "recovery-consumed": Record<string, never>;
  "recovery-used": RecoveryUsedData;
  "passkey-added": Record<string, never>;
  "passkey-removed": Record<string, never>;
  "totp-enrolled": Record<string, never>;
  "totp-disabled": Record<string, never>;
  "cross-device-login": Record<string, never>;
  "registry-gift-summary": RegistryGiftSummaryData;
  "vendor-claim-invite": { claimUrl: string; vendorName: string };
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
    case "enquiry-new":
      return renderEnquiryNew(data as EmailTemplateData<"enquiry-new">);
    case "enquiry-reply":
      return renderEnquiryReply(data as EmailTemplateData<"enquiry-reply">);
    case "enquiry-quote":
      return renderEnquiryQuote(data as EmailTemplateData<"enquiry-quote">);
    case "otp-registration":
      return renderRegistrationOtp(data as EmailTemplateData<"otp-registration">);
    case "otp-step-up":
      return renderStepUpOtp(data as EmailTemplateData<"otp-step-up">);
    case "otp-email-change":
      return renderEmailChangeOtp(data as EmailTemplateData<"otp-email-change">);
    case "otp-recovery":
      return renderRecoveryOtp(data as EmailTemplateData<"otp-recovery">);
    case "recovery-generated":
      return renderRecoveryGenerated();
    case "recovery-consumed":
      return renderRecoveryConsumed();
    case "recovery-used":
      return renderRecoveryUsed(data as EmailTemplateData<"recovery-used">);
    case "passkey-added":
      return renderPasskeyAdded();
    case "passkey-removed":
      return renderPasskeyRemoved();
    case "totp-enrolled":
      return renderTotpEnrolled();
    case "totp-disabled":
      return renderTotpDisabled();
    case "cross-device-login":
      return renderCrossDeviceLogin();
    case "registry-gift-summary":
      return renderRegistryGiftSummary(data as EmailTemplateData<"registry-gift-summary">);
    case "vendor-claim-invite":
      return renderVendorClaimInvite(data as EmailTemplateData<"vendor-claim-invite">);
  }
  // Exhaustive — compile error if a template is added without a branch.
  const _exhaustive: never = template;
  return _exhaustive;
}

export {
  renderEnquiryNew,
  renderEnquiryReply,
  renderEnquiryQuote,
  renderRegistrationOtp,
  renderStepUpOtp,
  renderEmailChangeOtp,
  renderRecoveryOtp,
  renderRecoveryGenerated,
  renderRecoveryConsumed,
  renderRecoveryUsed,
  renderPasskeyAdded,
  renderPasskeyRemoved,
  renderTotpEnrolled,
  renderTotpDisabled,
  renderCrossDeviceLogin,
  renderRegistryGiftSummary,
  renderVendorClaimInvite,
};

export type {
  EnquiryNewData,
  EnquiryReplyData,
  EnquiryQuoteData,
  RegistryGiftSummaryData,
  VendorClaimInviteData,
};
