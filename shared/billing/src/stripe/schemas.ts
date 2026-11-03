/**
 * The parts of Stripe's objects (API version `2025-03-31.basil`) this package
 * reads, as Effect Schemas. Unknown keys are ignored, so each schema names only
 * what the code uses.
 *
 * What these deliberately do not read: an invoice carries `customer_address`,
 * `customer_email`, `customer_name`, `customer_phone`, `customer_shipping` and
 * `customer_tax_ids`, and a customer carries `address`, `email`, `name` and
 * `tax_ids`. They arrive in webhook bodies and responses all the same, so
 * `@shared/observability`'s redaction list names each one.
 */

import { Schema } from "effect";

const Str = Schema.String;
const Num = Schema.Number;
const NullableStr = Schema.optional(Schema.NullOr(Str));
const NullableNum = Schema.optional(Schema.NullOr(Num));
const Metadata = Schema.optional(Schema.NullOr(Schema.Record(Str, Str)));

const Recurring = Schema.optional(Schema.NullOr(Schema.Struct({ interval: Str })));

export const StripePrice = Schema.Struct({
  id: Str,
  active: Schema.Boolean,
  currency: Str,
  unit_amount: NullableNum,
  tax_behavior: NullableStr,
  lookup_key: NullableStr,
  product: Str,
  metadata: Metadata,
  recurring: Recurring,
  currency_options: Schema.optional(
    Schema.NullOr(
      Schema.Record(Str, Schema.Struct({ unit_amount: NullableNum, tax_behavior: NullableStr })),
    ),
  ),
});
export type StripePrice = typeof StripePrice.Type;

export const StripePriceList = Schema.Struct({
  data: Schema.Array(StripePrice),
  has_more: Schema.optional(Schema.Boolean),
});

/** Basil moved the billing period off the subscription onto each item. */
export const StripeSubscription = Schema.Struct({
  id: Str,
  customer: Str,
  status: Str,
  currency: Str,
  cancel_at_period_end: Schema.optional(Schema.Boolean),
  trial_end: NullableNum,
  latest_invoice: NullableStr,
  items: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        current_period_start: NullableNum,
        current_period_end: NullableNum,
        price: Schema.Struct({
          id: Str,
          product: Str,
          metadata: Metadata,
          recurring: Recurring,
        }),
      }),
    ),
  }),
});

export const StripeCheckoutSession = Schema.Struct({
  id: Str,
  status: NullableStr,
  url: NullableStr,
  mode: NullableStr,
  customer: NullableStr,
  subscription: NullableStr,
});

/** Basil: the subscription sits under `parent`, on the invoice and on each line. */
export const StripeInvoice = Schema.Struct({
  id: Str,
  status: NullableStr,
  billing_reason: NullableStr,
  /** After discounts and tax. A line's `amount` is before discounts. */
  total: NullableNum,
  parent: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Str,
        subscription_details: Schema.optional(
          Schema.NullOr(Schema.Struct({ subscription: NullableStr })),
        ),
      }),
    ),
  ),
  lines: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        amount: Num,
        period: Schema.Struct({ start: Num, end: Num }),
        parent: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              type: Str,
              subscription_item_details: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    subscription: NullableStr,
                    proration: Schema.optional(Schema.Boolean),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  }),
});
export type StripeInvoice = typeof StripeInvoice.Type;

export const StripeEventEnvelope = Schema.Struct({
  id: Str,
  type: Str,
  account: NullableStr,
  data: Schema.Struct({ object: Schema.Unknown }),
});

export const StripePortalConfiguration = Schema.Struct({
  id: Str,
  active: Schema.optional(Schema.Boolean),
  metadata: Metadata,
  features: Schema.optional(Schema.Unknown),
});
export const StripePortalConfigurationList = Schema.Struct({
  data: Schema.Array(StripePortalConfiguration),
  has_more: Schema.optional(Schema.Boolean),
});

export const StripeProduct = Schema.Struct({
  id: Str,
  name: Str,
  active: Schema.optional(Schema.Boolean),
  tax_code: NullableStr,
  metadata: Metadata,
});

/** Any object read only for its id. */
export const StripeIdOnly = Schema.Struct({ id: Str });

/** A portal session: its URL is all the package hands on. */
export const StripePortalSession = Schema.Struct({ id: Str, url: NullableStr });
