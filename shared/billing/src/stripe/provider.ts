/**
 * The Stripe implementation of {@link BillingProvider}.
 *
 * Every call goes through {@link createStripeRequest} (pinned API version, one
 * timeout over the fetch and the body, `instrumentedFetch` by default) and
 * {@link stripeCall} (a span, the duration metric, errors narrowed to the
 * port's). Connect is never used: no call sets `Stripe-Account`, and the
 * webhook refuses any event naming an account.
 */

import { Effect } from "effect";

import { BillingProviderError, WebhookSignatureError } from "../errors";
import type {
  BillingProvider,
  ProviderCheckoutSession,
  ProviderEvent,
  ProviderPrice,
  ProviderSubscription,
  SubscriptionCheckoutInput,
} from "../provider/port";
import { createStripeRequest, type StripeFormParams, type StripeRequestConfig } from "./http";
import { decodeStripe, stripeCall } from "./instrument";
import { invoiceSubscriptionId, paidPeriodOf } from "./paid-period";
import {
  StripeCheckoutSession,
  StripeEventEnvelope,
  StripeIdOnly,
  StripeInvoice,
  StripePortalSession,
  StripePriceList,
  StripeSubscription,
  type StripePrice,
} from "./schemas";
import { verifyStripeWebhook } from "./verify";

/** Stripe allows at most this many `lookup_keys` in one price list call. */
export const LOOKUP_KEYS_PER_CALL = 10;

export interface StripeProviderConfig extends StripeRequestConfig {
  /** This endpoint's signing secret. `null` refuses every delivery. */
  readonly webhookSecret: string | null;
}

const date = (seconds: number | null | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000) : null;

const str = (value: string | null | undefined) =>
  typeof value === "string" && value !== "" ? value : null;

export function toProviderPrice(price: StripePrice): ProviderPrice {
  const options: Record<string, { unitAmount: number | null; taxBehavior: string | null }> = {};
  for (const [currency, option] of Object.entries(price.currency_options ?? {})) {
    if (currency === price.currency) continue;
    options[currency.toUpperCase()] = {
      unitAmount: option.unit_amount ?? null,
      taxBehavior: option.tax_behavior ?? null,
    };
  }
  return {
    id: price.id,
    active: price.active,
    lookupKey: str(price.lookup_key),
    productId: price.product,
    planIdMetadata: str(price.metadata?.plan_id),
    currency: price.currency.toUpperCase(),
    unitAmount: price.unit_amount ?? null,
    taxBehavior: str(price.tax_behavior),
    interval: str(price.recurring?.interval),
    currencyOptions: options,
  };
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

function checkoutForm(input: SubscriptionCheckoutInput): StripeFormParams {
  const { tax } = input;
  return {
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: input.clientReferenceId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    // Always explicit: the page shows one currency and the buyer pays in it.
    currency: input.currency.toLowerCase(),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // Stripe refuses fewer than one day, so an ineligible customer sends none.
    subscription_data:
      input.trialDays === null ? undefined : { trial_period_days: input.trialDays },
    automatic_tax: tax.automatic ? { enabled: true } : undefined,
    tax_id_collection: tax.collectTaxIds
      ? { enabled: true, required: tax.requireTaxId ? "if_supported" : undefined }
      : undefined,
    // The customer exists before Checkout, so Checkout must be told to write
    // back what the buyer enters: the address tax is computed from, and the
    // name a tax id is registered to.
    customer_update:
      tax.automatic || tax.collectTaxIds
        ? {
            address: tax.automatic ? "auto" : undefined,
            name: tax.collectTaxIds ? "auto" : undefined,
          }
        : undefined,
  };
}

const sessionStatus = (status: string | null | undefined): ProviderCheckoutSession["status"] =>
  status === "open" ? "open" : status === "complete" ? "complete" : "expired";

export function createStripeProvider(config: StripeProviderConfig): BillingProvider {
  const request = createStripeRequest(config);

  const toSubscription = (raw: typeof StripeSubscription.Type): ProviderSubscription | null => {
    const item = raw.items.data[0];
    if (!item) return null;
    return {
      id: raw.id,
      customerId: raw.customer,
      status: raw.status,
      currency: raw.currency.toUpperCase(),
      priceId: item.price.id,
      productId: item.price.product,
      planIdMetadata: str(item.price.metadata?.plan_id),
      interval: str(item.price.recurring?.interval),
      currentPeriodStart: date(item.current_period_start),
      currentPeriodEnd: date(item.current_period_end),
      trialEnd: date(raw.trial_end),
      cancelAtPeriodEnd: raw.cancel_at_period_end === true,
      latestInvoiceId: str(raw.latest_invoice),
    };
  };

  const decodeEvent = (
    raw: unknown,
  ): Effect.Effect<ProviderEvent, WebhookSignatureError | BillingProviderError> =>
    Effect.gen(function* () {
      const envelope = yield* decodeStripe(StripeEventEnvelope)(raw).pipe(
        // Signed but not an event at all: nothing a retry can fix.
        Effect.mapError(() => new WebhookSignatureError({ reason: "malformed" })),
      );
      const base = { id: envelope.id, type: envelope.type };
      if (str(envelope.account) !== null) return { kind: "connect", ...base } as const;
      const object = envelope.data.object;
      switch (envelope.type) {
        case "checkout.session.completed": {
          const session = yield* decodeStripe(StripeCheckoutSession)(object);
          return {
            kind: "checkout_completed",
            ...base,
            sessionId: session.id,
            mode: session.mode ?? "",
            customerId: str(session.customer),
            subscriptionId: str(session.subscription),
          } as const;
        }
        case "checkout.session.expired": {
          const session = yield* decodeStripe(StripeCheckoutSession)(object);
          return {
            kind: "checkout_expired",
            ...base,
            sessionId: session.id,
            customerId: str(session.customer),
          } as const;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
        case "customer.subscription.paused":
        case "customer.subscription.resumed":
        case "customer.subscription.trial_will_end": {
          const sub = yield* decodeStripe(StripeIdOnly)(object);
          return { kind: "subscription", ...base, subscriptionId: sub.id } as const;
        }
        case "invoice.paid":
        case "invoice.payment_failed": {
          const invoice = yield* decodeStripe(StripeInvoice)(object);
          const subscriptionId = invoiceSubscriptionId(invoice);
          if (subscriptionId === null) return { kind: "ignored", ...base } as const;
          if (envelope.type === "invoice.payment_failed") {
            return { kind: "subscription", ...base, subscriptionId } as const;
          }
          // The event's invoice is Stripe's own signed record. `paid` is
          // final for an invoice, so a late or replayed delivery cannot
          // confirm something that was not paid.
          return {
            kind: "invoice_paid",
            ...base,
            subscriptionId,
            paidPeriod: paidPeriodOf(invoice, subscriptionId),
          } as const;
        }
        default: {
          return { kind: "ignored", ...base } as const;
        }
      }
    });

  return {
    createCustomer: (input) =>
      stripeCall(
        "create_customer",
        request(
          "POST",
          "/v1/customers",
          // Only what never changes, so a retry under the same key is the same
          // request. The name arrives from Checkout (`customer_update[name]`).
          { metadata: { billing_customer: input.billingCustomerId } },
          { idempotencyKey: input.idempotencyKey },
        ).pipe(
          Effect.flatMap(decodeStripe(StripeIdOnly)),
          Effect.map((customer) => ({ id: customer.id })),
        ),
      ),

    listPrices: (lookupKeys) =>
      stripeCall(
        "list_prices",
        Effect.forEach(
          chunk(lookupKeys, LOOKUP_KEYS_PER_CALL),
          (keys) =>
            request("GET", "/v1/prices", {
              lookup_keys: keys,
              active: true,
              // `currency_options` is includable: absent unless expanded.
              expand: ["data.currency_options"],
              limit: 100,
            }).pipe(Effect.flatMap(decodeStripe(StripePriceList))),
          { concurrency: 4 },
        ).pipe(Effect.map((pages) => pages.flatMap((page) => page.data.map(toProviderPrice)))),
      ),

    createSubscriptionCheckout: (input) =>
      stripeCall(
        "create_checkout_session",
        request("POST", "/v1/checkout/sessions", checkoutForm(input), {
          idempotencyKey: input.idempotencyKey,
        }).pipe(
          Effect.flatMap(decodeStripe(StripeCheckoutSession)),
          Effect.flatMap((session) =>
            session.url
              ? Effect.succeed({ id: session.id, url: session.url })
              : Effect.fail(new BillingProviderError({ reason: "unexpected_payload" })),
          ),
        ),
      ),

    retrieveCheckoutSession: (id) =>
      stripeCall(
        "retrieve_checkout_session",
        request("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`).pipe(
          Effect.flatMap(decodeStripe(StripeCheckoutSession)),
          Effect.map((session) => ({
            id: session.id,
            status: sessionStatus(session.status),
            url: str(session.url),
          })),
        ),
      ),

    expireCheckoutSession: (id) =>
      stripeCall(
        "expire_checkout_session",
        request(
          "POST",
          `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`,
          {},
          { idempotencyKey: `billing-checkout-expire-${id}` },
        ).pipe(
          Effect.flatMap(decodeStripe(StripeCheckoutSession)),
          Effect.flatMap((session) =>
            session.status === "expired"
              ? Effect.void
              : Effect.fail(new BillingProviderError({ reason: "not_expired" })),
          ),
        ),
      ),

    createPortalSession: (input) =>
      stripeCall(
        "create_portal_session",
        request("POST", "/v1/billing_portal/sessions", {
          customer: input.customerId,
          return_url: input.returnUrl,
          configuration: input.configuration,
        }).pipe(
          Effect.flatMap(decodeStripe(StripePortalSession)),
          Effect.flatMap((session) =>
            session.url
              ? Effect.succeed({ url: session.url })
              : Effect.fail(new BillingProviderError({ reason: "unexpected_payload" })),
          ),
        ),
      ),

    retrieveSubscription: (id) =>
      stripeCall(
        "retrieve_subscription",
        request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`).pipe(
          Effect.flatMap(decodeStripe(StripeSubscription)),
          Effect.map(toSubscription),
          Effect.catchTag("StripeError", (error) =>
            error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
          ),
        ),
      ),

    retrieveInvoicePaidPeriod: (invoiceId, subscriptionId) =>
      stripeCall(
        "retrieve_invoice",
        request("GET", `/v1/invoices/${encodeURIComponent(invoiceId)}`).pipe(
          Effect.flatMap(decodeStripe(StripeInvoice)),
          Effect.map((invoice) => paidPeriodOf(invoice, subscriptionId)),
        ),
      ),

    verifyWebhook: (input) =>
      verifyStripeWebhook({
        payload: input.payload,
        signatureHeader: input.headers.get("stripe-signature"),
        secret: config.webhookSecret,
        now: Math.floor(input.now.getTime() / 1000),
      }).pipe(
        Effect.mapError((error) => new WebhookSignatureError({ reason: error.reason })),
        Effect.flatMap(decodeEvent),
      ),
  };
}
