/**
 * Plans and features, declared in code.
 *
 * A plan's `price.amounts` and `price.taxBehavior` are read ONLY by `syncPlans`,
 * which writes them to Stripe. At run time Stripe is the source of truth for
 * prices: `catalogue()` reads them back, and checkout names a price by its
 * lookup key.
 */

export type BillingInterval = "month" | "year";
export type TaxBehavior = "exclusive" | "inclusive";

export interface Feature<Id extends string = string> {
  readonly id: Id;
}

export interface PlanPrice {
  readonly interval: BillingInterval;
  /** Upper-case ISO 4217; the Price's own currency. Must be a key of `amounts`. */
  readonly defaultCurrency: string;
  /** Minor units per upper-case currency. The non-default ones become `currency_options`. */
  readonly amounts: Readonly<Record<string, number>>;
  /** Fixed at Stripe once set to either value, so settle it before the first live sync. */
  readonly taxBehavior: TaxBehavior;
}

export interface Plan<Id extends string = string, FeatureId extends string = string> {
  readonly id: Id;
  readonly name: string;
  /** At most one live subscription per customer per group. */
  readonly group: string;
  /** The Stripe lookup key checkout resolves the price by. Unique per Stripe account. */
  readonly lookupKey: string;
  /** A Stripe product tax code; omitted, Stripe Tax uses the account's preset. */
  readonly taxCode?: string;
  /** Days of trial for a customer who has not had one. 0 or omitted is none. */
  readonly trialDays?: number;
  readonly features: readonly Feature<FeatureId>[];
  readonly price: PlanPrice;
}

export type AnyPlan = Plan<string, string>;
export type PlanIdOf<P extends readonly AnyPlan[]> = P[number]["id"];
export type FeatureIdOf<P extends readonly AnyPlan[]> = P[number]["features"][number]["id"];

/**
 * Plan ids name Stripe objects (product `billing_<id>`) and so are unique per
 * Stripe account; Stripe allows letters, digits, `_` and `-` in a custom id.
 */
const ID = /^[a-z][a-z0-9_]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;

export const defineFeature = <const Id extends string>(feature: { id: Id }): Feature<Id> => {
  if (!ID.test(feature.id)) throw new Error(`feature id "${feature.id}" must match ${ID}`);
  return Object.freeze({ id: feature.id });
};

export const definePlan = <const Id extends string, const FeatureId extends string>(
  plan: Plan<Id, FeatureId>,
): Plan<Id, FeatureId> => {
  if (!ID.test(plan.id)) throw new Error(`plan id "${plan.id}" must match ${ID}`);
  if (plan.lookupKey.trim() === "") throw new Error(`plan "${plan.id}" needs a lookup key`);
  if (plan.trialDays !== undefined && (!Number.isInteger(plan.trialDays) || plan.trialDays < 0)) {
    throw new Error(`plan "${plan.id}" trialDays must be a whole number of days`);
  }
  const { amounts, defaultCurrency } = plan.price;
  for (const [currency, amount] of Object.entries(amounts)) {
    if (!CURRENCY.test(currency)) {
      throw new Error(`plan "${plan.id}" currency "${currency}" must be upper-case ISO 4217`);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`plan "${plan.id}" amount for ${currency} must be a positive whole number`);
    }
  }
  if (!Object.hasOwn(amounts, defaultCurrency)) {
    throw new Error(`plan "${plan.id}" has no amount in its default currency ${defaultCurrency}`);
  }
  return Object.freeze({ ...plan });
};

/** Duplicate plan ids or lookup keys would map two plans onto one Stripe price. */
export function assertDistinctPlans(plans: readonly AnyPlan[]): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const plan of plans) {
    if (ids.has(plan.id)) throw new Error(`plan id "${plan.id}" is defined twice`);
    if (keys.has(plan.lookupKey)) throw new Error(`lookup key "${plan.lookupKey}" is used twice`);
    ids.add(plan.id);
    keys.add(plan.lookupKey);
  }
}

/** The Stripe product id a plan's prices hang off. */
export const productIdFor = (planId: string) => `billing_${planId}`;
