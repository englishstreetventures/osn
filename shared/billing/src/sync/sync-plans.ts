/**
 * Write the code-defined plans to Stripe: one product per plan, one price per
 * plan carrying every currency, and the billing portal configuration.
 *
 * Runs from a script, never at request time, and is a dry run unless `apply`
 * is set: it reads Stripe, works out every change, and only then writes. A
 * product or price it would touch that names ANOTHER plan is a conflict, and a
 * conflict stops every write. Plan ids name the products (`billing_<id>`), so
 * they are unique per Stripe account; so is the one portal configuration this
 * manages, found again by `metadata.managed_by`.
 *
 * Prices are never edited. A changed amount, currency, interval or tax
 * behaviour makes a new price that takes the lookup key over
 * (`transfer_lookup_key`); existing subscribers stay on the old one, which
 * still maps to the plan by its `metadata.plan_id`.
 */

import { Effect, Schema } from "effect";

import type { BillingProviderError } from "../errors";
import { productIdFor, type AnyPlan } from "../plans";
import type { ProviderPrice } from "../provider/port";
import type { StripeFormParams, StripeRequest } from "../stripe/http";
import { decodeStripe, stripeCall } from "../stripe/instrument";
import { LOOKUP_KEYS_PER_CALL, toProviderPrice } from "../stripe/provider";
import {
  StripeIdOnly,
  StripePortalConfiguration,
  StripePortalConfigurationList,
  StripePriceList,
  StripeProduct,
} from "../stripe/schemas";

export const PORTAL_MANAGED_BY = "billing-sync";

export type ProductAction = "create" | "update" | "ok" | "conflict";
export type PriceAction = "create" | "replace" | "update_metadata" | "ok" | "conflict";

export interface PlanSyncReport {
  readonly planId: string;
  readonly product: { readonly action: ProductAction; readonly changes: readonly string[] };
  readonly price: {
    readonly action: PriceAction;
    /** The price checkout will sell after this run (a new one is `null` on a dry run). */
    readonly priceId: string | null;
    readonly changes: readonly string[];
  };
}

export interface SyncReport {
  readonly applied: boolean;
  readonly conflicts: number;
  readonly plans: readonly PlanSyncReport[];
  readonly portal: {
    readonly action: "create" | "update" | "ok";
    /** Store it in the consumer's portal-configuration var. `null` before the first apply. */
    readonly configurationId: string | null;
    readonly changes: readonly string[];
  };
}

export interface SyncPlansOptions {
  readonly plans: readonly AnyPlan[];
  readonly request: StripeRequest;
  readonly apply: boolean;
}

const lower = (currency: string) => currency.toLowerCase();

/** What the price should be, per currency, in minor units. */
function priceChanges(plan: AnyPlan, price: ProviderPrice): string[] {
  const want = plan.price;
  const changes: string[] = [];
  if (price.productId !== productIdFor(plan.id))
    changes.push(`product: ${price.productId} → ${productIdFor(plan.id)}`);
  if (price.interval !== want.interval)
    changes.push(`interval: ${price.interval ?? "none"} → ${want.interval}`);
  if (price.taxBehavior !== want.taxBehavior) {
    changes.push(`tax_behavior: ${price.taxBehavior ?? "none"} → ${want.taxBehavior}`);
  }
  if (price.currency !== want.defaultCurrency)
    changes.push(`currency: ${price.currency} → ${want.defaultCurrency}`);
  const have = new Map<string, number | null>([
    [price.currency, price.unitAmount],
    ...Object.entries(price.currencyOptions).map(([c, o]) => [c, o.unitAmount] as const),
  ]);
  for (const [currency, amount] of Object.entries(want.amounts)) {
    const current = have.get(currency);
    if (current === undefined) changes.push(`${currency}: missing → ${amount}`);
    else if (current !== amount) changes.push(`${currency}: ${current ?? "none"} → ${amount}`);
  }
  for (const [currency, amount] of have) {
    if (!Object.hasOwn(want.amounts, currency))
      changes.push(`${currency}: ${amount ?? "none"} → removed`);
  }
  for (const [currency, option] of Object.entries(price.currencyOptions)) {
    if (
      Object.hasOwn(want.amounts, currency) &&
      option.taxBehavior !== null &&
      option.taxBehavior !== want.taxBehavior
    ) {
      changes.push(`${currency} tax_behavior: ${option.taxBehavior} → ${want.taxBehavior}`);
    }
  }
  return changes;
}

function priceForm(plan: AnyPlan): StripeFormParams {
  const { amounts, defaultCurrency, interval, taxBehavior } = plan.price;
  const options: Record<string, StripeFormParams> = {};
  for (const [currency, amount] of Object.entries(amounts)) {
    if (currency !== defaultCurrency)
      options[lower(currency)] = { unit_amount: amount, tax_behavior: taxBehavior };
  }
  return {
    product: productIdFor(plan.id),
    currency: lower(defaultCurrency),
    unit_amount: amounts[defaultCurrency],
    recurring: { interval },
    tax_behavior: taxBehavior,
    lookup_key: plan.lookupKey,
    // Also when nothing holds the key yet: an archived price can, and a plain
    // create would then be refused.
    transfer_lookup_key: true,
    currency_options: options,
    metadata: { plan_id: plan.id },
  };
}

/** The portal configuration this package manages. */
const PORTAL_FORM: StripeFormParams = {
  features: {
    customer_update: { enabled: true, allowed_updates: ["address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    // Off: a plan switch here would offer whatever prices the configuration
    // listed when it was saved, which go stale at the next sync.
    subscription_update: { enabled: false },
  },
  metadata: { managed_by: PORTAL_MANAGED_BY },
};

const PortalFeatures = Schema.Struct({
  customer_update: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      allowed_updates: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  invoice_history: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
  payment_method_update: Schema.optional(
    Schema.Struct({ enabled: Schema.optional(Schema.Boolean) }),
  ),
  subscription_cancel: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      mode: Schema.optional(Schema.String),
    }),
  ),
  subscription_update: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
});

function portalChanges(features: unknown): string[] {
  const read = Schema.decodeUnknownResult(PortalFeatures)(features ?? {});
  if (read._tag === "Failure") return ["features: unreadable → managed"];
  const f = read.success;
  const changes: string[] = [];
  const check = (name: string, have: unknown, want: unknown) => {
    if (JSON.stringify(have) !== JSON.stringify(want))
      changes.push(`${name}: ${JSON.stringify(have)} → ${JSON.stringify(want)}`);
  };
  check("customer_update.enabled", f.customer_update?.enabled, true);
  check("customer_update.allowed_updates", f.customer_update?.allowed_updates?.toSorted(), [
    "address",
    "tax_id",
  ]);
  check("invoice_history.enabled", f.invoice_history?.enabled, true);
  check("payment_method_update.enabled", f.payment_method_update?.enabled, true);
  check("subscription_cancel.enabled", f.subscription_cancel?.enabled, true);
  check("subscription_cancel.mode", f.subscription_cancel?.mode, "at_period_end");
  check("subscription_update.enabled", f.subscription_update?.enabled, false);
  return changes;
}

export const syncPlans = (
  options: SyncPlansOptions,
): Effect.Effect<SyncReport, BillingProviderError> =>
  Effect.gen(function* () {
    const { request, plans } = options;

    // Read everything first.
    const products = yield* Effect.forEach(
      plans,
      (plan) =>
        stripeCall(
          "retrieve_product",
          request("GET", `/v1/products/${encodeURIComponent(productIdFor(plan.id))}`).pipe(
            Effect.flatMap(decodeStripe(StripeProduct)),
            Effect.map((product) => product as typeof StripeProduct.Type | null),
            Effect.catchTag("StripeError", (error) =>
              error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    const keys = plans.map((p) => p.lookupKey);
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += LOOKUP_KEYS_PER_CALL)
      chunks.push(keys.slice(i, i + LOOKUP_KEYS_PER_CALL));
    const prices = (yield* Effect.forEach(
      chunks,
      (lookupKeys) =>
        stripeCall(
          "list_prices",
          request("GET", "/v1/prices", {
            lookup_keys: lookupKeys,
            active: true,
            expand: ["data.currency_options"],
            limit: 100,
          }).pipe(Effect.flatMap(decodeStripe(StripePriceList))),
        ),
      { concurrency: 4 },
    )).flatMap((page) => page.data.map(toProviderPrice));
    const priceByKey = new Map(prices.map((p) => [p.lookupKey, p]));

    const configurations: (typeof StripePortalConfiguration.Type)[] = [];
    for (let after: string | undefined, more = true; more;) {
      const page = yield* stripeCall(
        "list_portal_configurations",
        request("GET", "/v1/billing_portal/configurations", {
          limit: 100,
          starting_after: after,
        }).pipe(Effect.flatMap(decodeStripe(StripePortalConfigurationList))),
      );
      configurations.push(...page.data);
      more = page.has_more === true && page.data.length > 0;
      after = page.data.at(-1)?.id;
    }
    const managed =
      configurations.find((c) => c.metadata?.managed_by === PORTAL_MANAGED_BY) ?? null;

    // Work out every change.
    const planned = plans.map((plan, i) => {
      const product = products[i] ?? null;
      const productName = product?.metadata?.plan_id;
      const productAction: ProductAction =
        product === null
          ? "create"
          : productName !== undefined && productName !== plan.id
            ? "conflict"
            : product.name !== plan.name ||
                (plan.taxCode !== undefined && product.tax_code !== plan.taxCode)
              ? "update"
              : "ok";
      const productChanges =
        product === null
          ? [`create ${productIdFor(plan.id)}`]
          : productAction === "conflict"
            ? [`names plan ${productName}`]
            : [
                ...(product.name === plan.name ? [] : [`name: ${product.name} → ${plan.name}`]),
                ...(plan.taxCode === undefined || product.tax_code === plan.taxCode
                  ? []
                  : [`tax_code: ${product.tax_code ?? "none"} → ${plan.taxCode}`]),
              ];

      const price = priceByKey.get(plan.lookupKey);
      let priceAction: PriceAction;
      let changes: string[];
      if (price === undefined) {
        priceAction = "create";
        changes = Object.entries(plan.price.amounts).map(([c, a]) => `${c}: missing → ${a}`);
      } else if (price.planIdMetadata !== null && price.planIdMetadata !== plan.id) {
        priceAction = "conflict";
        changes = [`${price.id} names plan ${price.planIdMetadata}`];
      } else {
        changes = priceChanges(plan, price);
        priceAction =
          changes.length > 0 ? "replace" : price.planIdMetadata === null ? "update_metadata" : "ok";
        if (priceAction === "update_metadata") changes = ["metadata.plan_id: missing → " + plan.id];
      }
      return {
        plan,
        product: { action: productAction, changes: productChanges },
        price: { action: priceAction, current: price, changes },
      };
    });
    const conflicts = planned.filter(
      (p) => p.product.action === "conflict" || p.price.action === "conflict",
    ).length;
    const portalChangeList = managed === null ? ["create"] : portalChanges(managed.features);
    const portalAction =
      managed === null ? "create" : portalChangeList.length > 0 ? "update" : "ok";
    const apply = options.apply && conflicts === 0;

    // Then, only when asked and nothing conflicts, write.
    const results: PlanSyncReport[] = [];
    for (const step of planned) {
      const { plan } = step;
      let priceId = step.price.current?.id ?? null;
      if (apply) {
        if (step.product.action === "create") {
          yield* stripeCall(
            "create_product",
            request("POST", "/v1/products", {
              id: productIdFor(plan.id),
              name: plan.name,
              tax_code: plan.taxCode,
              metadata: { plan_id: plan.id },
            }),
          );
        } else if (step.product.action === "update") {
          yield* stripeCall(
            "update_product",
            request("POST", `/v1/products/${encodeURIComponent(productIdFor(plan.id))}`, {
              name: plan.name,
              tax_code: plan.taxCode,
              metadata: { plan_id: plan.id },
            }),
          );
        }
        if (step.price.action === "create" || step.price.action === "replace") {
          const created = yield* stripeCall(
            "create_price",
            request("POST", "/v1/prices", priceForm(plan)).pipe(
              Effect.flatMap(decodeStripe(StripeIdOnly)),
            ),
          );
          priceId = created.id;
        } else if (step.price.action === "update_metadata" && priceId !== null) {
          yield* stripeCall(
            "update_price",
            request("POST", `/v1/prices/${encodeURIComponent(priceId)}`, {
              metadata: { plan_id: plan.id },
            }),
          );
        }
      } else if (step.price.action === "create" || step.price.action === "replace") {
        priceId = null;
      }
      results.push({
        planId: plan.id,
        product: step.product,
        price: { action: step.price.action, priceId, changes: step.price.changes },
      });
    }

    let configurationId = managed?.id ?? null;
    if (apply && portalAction === "create") {
      const created = yield* stripeCall(
        "create_portal_configuration",
        request("POST", "/v1/billing_portal/configurations", PORTAL_FORM).pipe(
          Effect.flatMap(decodeStripe(StripePortalConfiguration)),
        ),
      );
      configurationId = created.id;
    } else if (apply && portalAction === "update" && managed !== null) {
      yield* stripeCall(
        "update_portal_configuration",
        request(
          "POST",
          `/v1/billing_portal/configurations/${encodeURIComponent(managed.id)}`,
          PORTAL_FORM,
        ),
      );
    }

    return {
      applied: apply,
      conflicts,
      plans: results,
      portal: { action: portalAction, configurationId, changes: portalChangeList },
    } satisfies SyncReport;
  }).pipe(Effect.withSpan("billing.sync"));
