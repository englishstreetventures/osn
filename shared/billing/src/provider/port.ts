/**
 * What the billing core asks of a payment provider. Stripe implements it
 * (`@shared/billing/stripe`); tests and a future provider implement the same
 * shape. Every value here is already normalised: upper-case currencies, `Date`s,
 * provider ids as strings.
 */

import type { Effect } from "effect";

import type { BillingProviderError, WebhookSignatureError } from "../errors";

export interface ProviderPrice {
  readonly id: string;
  readonly active: boolean;
  readonly lookupKey: string | null;
  readonly productId: string;
  /** `metadata.plan_id` on the price: how a price maps back to a plan. */
  readonly planIdMetadata: string | null;
  readonly currency: string;
  readonly unitAmount: number | null;
  readonly taxBehavior: string | null;
  readonly interval: string | null;
  /** Non-default currencies, keyed upper-case. */
  readonly currencyOptions: Readonly<
    Record<string, { readonly unitAmount: number | null; readonly taxBehavior: string | null }>
  >;
}

export interface ProviderSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly currency: string;
  readonly priceId: string;
  readonly productId: string;
  readonly planIdMetadata: string | null;
  readonly interval: string | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly latestInvoiceId: string | null;
}

/** A billing period the provider has confirmed paid. */
export interface PaidPeriod {
  readonly start: Date;
  readonly end: Date;
}

export interface ProviderCheckoutSession {
  readonly id: string;
  readonly status: "open" | "complete" | "expired";
  readonly url: string | null;
}

export interface SubscriptionCheckoutInput {
  readonly customerId: string;
  readonly priceId: string;
  /** Upper-case ISO; the provider sends it in its own case. */
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly clientReferenceId: string;
  /** `null` when the customer is not trial-eligible. */
  readonly trialDays: number | null;
  readonly tax: TaxOptions;
  readonly idempotencyKey: string;
}

export interface TaxOptions {
  /** Stripe Tax computes and adds tax at checkout. */
  readonly automatic: boolean;
  /** Checkout offers a tax-id field. */
  readonly collectTaxIds: boolean;
  /** A tax id is required where collection is supported for the buyer's country. */
  readonly requireTaxId: boolean;
}

/**
 * A verified webhook event, reduced to what the core acts on. `mode` stays on
 * a completed checkout so a one-off purchase (`payment`) can be routed later
 * without changing this shape; today the core ignores it.
 */
export type ProviderEvent =
  | { readonly kind: "connect"; readonly id: string; readonly type: string }
  | { readonly kind: "ignored"; readonly id: string; readonly type: string }
  | {
      readonly kind: "subscription";
      readonly id: string;
      readonly type: string;
      readonly subscriptionId: string;
    }
  | {
      readonly kind: "checkout_completed";
      readonly id: string;
      readonly type: string;
      readonly sessionId: string;
      readonly mode: string;
      readonly customerId: string | null;
      readonly subscriptionId: string | null;
    }
  | {
      readonly kind: "checkout_expired";
      readonly id: string;
      readonly type: string;
      readonly sessionId: string;
      readonly customerId: string | null;
    }
  | {
      readonly kind: "invoice_paid";
      readonly id: string;
      readonly type: string;
      readonly subscriptionId: string;
      readonly paidPeriod: PaidPeriod | null;
    };

export interface BillingProvider {
  /** The longest one call may take before it fails as a timeout. */
  readonly callTimeoutMs: number;
  createCustomer(input: {
    readonly billingCustomerId: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<{ readonly id: string }, BillingProviderError>;
  /** Active prices holding these lookup keys, with every currency option. */
  listPrices(
    lookupKeys: readonly string[],
  ): Effect.Effect<readonly ProviderPrice[], BillingProviderError>;
  createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Effect.Effect<{ readonly id: string; readonly url: string }, BillingProviderError>;
  retrieveCheckoutSession(id: string): Effect.Effect<ProviderCheckoutSession, BillingProviderError>;
  /** Fails when the session is not open any more (it may have completed). */
  expireCheckoutSession(id: string): Effect.Effect<void, BillingProviderError>;
  createPortalSession(input: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly configuration: string | undefined;
  }): Effect.Effect<{ readonly url: string }, BillingProviderError>;
  /** `null` when the provider has no such subscription. */
  retrieveSubscription(
    id: string,
  ): Effect.Effect<ProviderSubscription | null, BillingProviderError>;
  /** The paid period an invoice confirms for this subscription, if any. */
  retrieveInvoicePaidPeriod(
    invoiceId: string,
    subscriptionId: string,
  ): Effect.Effect<PaidPeriod | null, BillingProviderError>;
  verifyWebhook(input: {
    readonly payload: string;
    readonly headers: Headers;
    readonly now: Date;
  }): Effect.Effect<ProviderEvent, WebhookSignatureError | BillingProviderError>;
}
