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
import {
  renderRegistryGiftSummary,
  type RegistryGiftSummaryData,
  type RegistryGiftSummaryGift,
  type RegistryGiftSummaryTotal,
} from "./gift-summary";
import {
  type OtpData,
  renderEmailChangeOtp,
  renderRecoveryOtp,
  renderRegistrationOtp,
  renderStepUpOtp,
} from "./otp";
import { renderR2ReconcileAlert, type R2ReconcileAlertData } from "./r2-reconcile-alert";
import {
  renderRsvpChangeDigest,
  type RsvpChangeDigestData,
  type RsvpDigestChangeKind,
} from "./rsvp-digest";
import {
  type InstanceNameData,
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
import {
  renderVendorClaimReviewPending,
  type VendorClaimReviewPendingData,
} from "./vendor-claim-review";
import {
  renderWeddingDeleteStarted,
  renderWeddingOwnerChange,
  type WeddingDeleteStartedData,
  type WeddingOwnerAudience,
  type WeddingOwnerChangeData,
  type WeddingOwnerNewRole,
} from "./wedding-owner";

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
  | "r2-reconcile-alert"
  | "registry-gift-summary"
  | "rsvp-change-digest"
  | "vendor-claim-invite"
  | "vendor-claim-review-pending"
  | "wedding-delete-started"
  | "wedding-owner-change";

/**
 * The account emails osn-api sends to an account holder. Each names the
 * identity instance it comes from, from `instanceName` in its data.
 */
export type AccountEmailTemplate =
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
  | "cross-device-login";

/** Typed data bag per template. Extend the map when adding a template. */
export interface EmailTemplateDataMap {
  "enquiry-new": EnquiryNewData;
  "enquiry-reply": EnquiryReplyData;
  "enquiry-quote": EnquiryQuoteData;
  "otp-registration": OtpData;
  "otp-step-up": OtpData;
  "otp-email-change": OtpData;
  "otp-recovery": OtpData;
  "recovery-generated": InstanceNameData;
  "recovery-consumed": InstanceNameData;
  "recovery-used": RecoveryUsedData;
  "passkey-added": InstanceNameData;
  "passkey-removed": InstanceNameData;
  "totp-enrolled": InstanceNameData;
  "totp-disabled": InstanceNameData;
  "cross-device-login": InstanceNameData;
  "r2-reconcile-alert": R2ReconcileAlertData;
  "registry-gift-summary": RegistryGiftSummaryData;
  "rsvp-change-digest": RsvpChangeDigestData;
  "vendor-claim-invite": { claimUrl: string; vendorName: string };
  "vendor-claim-review-pending": VendorClaimReviewPendingData;
  "wedding-delete-started": WeddingDeleteStartedData;
  "wedding-owner-change": WeddingOwnerChangeData;
}

export type EmailTemplateData<T extends EmailTemplate> = EmailTemplateDataMap[T];

/** Rendered email — what the transport sends to the provider. */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Extra message headers, e.g. `List-Unsubscribe`. The Resend transport sends
   * them; the Cloudflare and log transports do not. Values must hold no line
   * break — the renderer strips them.
   */
  readonly headers?: Readonly<Record<string, string>>;
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
      return renderRecoveryGenerated(data as EmailTemplateData<"recovery-generated">);
    case "recovery-consumed":
      return renderRecoveryConsumed(data as EmailTemplateData<"recovery-consumed">);
    case "recovery-used":
      return renderRecoveryUsed(data as EmailTemplateData<"recovery-used">);
    case "passkey-added":
      return renderPasskeyAdded(data as EmailTemplateData<"passkey-added">);
    case "passkey-removed":
      return renderPasskeyRemoved(data as EmailTemplateData<"passkey-removed">);
    case "totp-enrolled":
      return renderTotpEnrolled(data as EmailTemplateData<"totp-enrolled">);
    case "totp-disabled":
      return renderTotpDisabled(data as EmailTemplateData<"totp-disabled">);
    case "cross-device-login":
      return renderCrossDeviceLogin(data as EmailTemplateData<"cross-device-login">);
    case "r2-reconcile-alert":
      return renderR2ReconcileAlert(data as EmailTemplateData<"r2-reconcile-alert">);
    case "registry-gift-summary":
      return renderRegistryGiftSummary(data as EmailTemplateData<"registry-gift-summary">);
    case "rsvp-change-digest":
      return renderRsvpChangeDigest(data as EmailTemplateData<"rsvp-change-digest">);
    case "vendor-claim-invite":
      return renderVendorClaimInvite(data as EmailTemplateData<"vendor-claim-invite">);
    case "vendor-claim-review-pending":
      return renderVendorClaimReviewPending(
        data as EmailTemplateData<"vendor-claim-review-pending">,
      );
    case "wedding-delete-started":
      return renderWeddingDeleteStarted(data as EmailTemplateData<"wedding-delete-started">);
    case "wedding-owner-change":
      return renderWeddingOwnerChange(data as EmailTemplateData<"wedding-owner-change">);
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
  renderR2ReconcileAlert,
  renderRegistryGiftSummary,
  renderRsvpChangeDigest,
  renderVendorClaimInvite,
  renderVendorClaimReviewPending,
  renderWeddingDeleteStarted,
  renderWeddingOwnerChange,
};

export type {
  EnquiryNewData,
  InstanceNameData,
  OtpData,
  EnquiryReplyData,
  EnquiryQuoteData,
  R2ReconcileAlertData,
  RecoveryUsedData,
  RegistryGiftSummaryData,
  RegistryGiftSummaryGift,
  RegistryGiftSummaryTotal,
  RsvpChangeDigestData,
  RsvpDigestChangeKind,
  VendorClaimInviteData,
  VendorClaimReviewPendingData,
  WeddingDeleteStartedData,
  WeddingOwnerAudience,
  WeddingOwnerChangeData,
  WeddingOwnerNewRole,
};
