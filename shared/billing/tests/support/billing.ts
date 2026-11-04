import { Effect } from "effect";

import {
  createBilling,
  defineFeature,
  definePlan,
  type AccessDecision,
  type BillingOptions,
  type BillingStorage,
} from "../../src";
import { createStripeProvider } from "../../src/stripe";
import { createTestStorage } from "./db";
import { createFakeStripe, priceJson, WEBHOOK_SECRET } from "./fake-stripe";

export const workspace = defineFeature({ id: "workspace" });
export const reports = defineFeature({ id: "reports" });

export const monthly = definePlan({
  id: "monthly",
  name: "Monthly",
  group: "workspace",
  lookupKey: "workspace_monthly_v1",
  trialDays: 30,
  features: [workspace],
  price: {
    interval: "month",
    defaultCurrency: "AUD",
    amounts: { AUD: 4900, USD: 3500, NZD: 5200 },
    taxBehavior: "exclusive",
  },
});

export const annual = definePlan({
  id: "annual",
  name: "Annual",
  group: "workspace",
  lookupKey: "workspace_annual_v1",
  features: [workspace, reports],
  price: {
    interval: "year",
    defaultCurrency: "AUD",
    amounts: { AUD: 49_000 },
    taxBehavior: "exclusive",
  },
});

export const PLANS = [monthly, annual] as const;
export const T0 = new Date("2030-06-01T00:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const unix = (date: Date) => Math.floor(date.getTime() / 1000);

type HarnessOptions = Partial<
  Pick<BillingOptions<typeof PLANS>, "tax" | "policy" | "tuning" | "hooks">
> & {
  /** Stands in front of the billing instance's storage, to count or race its calls. */
  readonly wrap?: (storage: BillingStorage) => BillingStorage;
};

/** The one origin the harness's return URLs may point at. */
export const APP_ORIGIN = "https://app.example.test";

export async function createHarness(options: HarnessOptions = {}) {
  const { storage, db, schema } = await createTestStorage();
  const stripe = createFakeStripe();
  stripe.prices.push(
    priceJson({
      id: "price_monthly",
      lookupKey: "workspace_monthly_v1",
      product: "billing_monthly",
      planId: "monthly",
      currencyOptions: { USD: 3500, NZD: 5200 },
    }),
    priceJson({
      id: "price_annual",
      lookupKey: "workspace_annual_v1",
      product: "billing_annual",
      planId: "annual",
      unitAmount: 49_000,
      interval: "year",
    }),
  );
  let clock = T0;
  const decisions: AccessDecision<"workspace" | "reports">[] = [];
  const provider = createStripeProvider({
    secretKey: "sk_test_harness",
    webhookSecret: WEBHOOK_SECRET,
    fetchImpl: stripe.fetchImpl,
    timeoutMs: 1_000,
  });
  const billing = createBilling({
    plans: PLANS,
    storage: options.wrap ? options.wrap(storage) : storage,
    provider,
    now: () => clock,
    returnOrigins: [APP_ORIGIN],
    hooks: options.hooks ?? {
      onAccess: (decision) => Effect.sync(() => void decisions.push(decision)),
    },
    tuning: {
      backoffMs: 2,
      accessBudgetMs: 150,
      checkoutPollMs: 2,
      checkoutWaitMs: 150,
      customerRetryMs: 2,
      ...options.tuning,
    },
    ...(options.tax ? { tax: options.tax } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  return {
    billing,
    stripe,
    storage,
    db,
    schema,
    decisions,
    now: () => clock,
    setNow: (date: Date) => {
      clock = date;
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
export const flip = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

/** Wraps a storage so each method's calls are counted by name. */
export function counting(calls: Map<string, number>) {
  return (storage: BillingStorage): BillingStorage =>
    new Proxy(storage, {
      get(target, key, receiver) {
        if (typeof key === "string") calls.set(key, (calls.get(key) ?? 0) + 1);
        return Reflect.get(target, key, receiver);
      },
    });
}
