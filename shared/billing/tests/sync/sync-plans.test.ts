import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { definePlan } from "../../src";
import { createStripeRequest } from "../../src/stripe";
import { syncPlans } from "../../src/sync/sync-plans";
import { annual, monthly, PLANS } from "../support/billing";
import { createFakeStripe, priceJson } from "../support/fake-stripe";

const setup = (options?: Parameters<typeof createFakeStripe>[0]) => {
  const stripe = createFakeStripe(options);
  const request = createStripeRequest({ secretKey: "sk_test_sync", fetchImpl: stripe.fetchImpl });
  return { stripe, request };
};

const posts = (stripe: ReturnType<typeof createFakeStripe>) =>
  stripe.calls.filter((c) => c.method === "POST");

/** Stripe as a previous sync left it: monthly at AUD 4900 with USD 3500 and GBP 3000. */
function synced(stripe: ReturnType<typeof createFakeStripe>) {
  for (const plan of PLANS) {
    stripe.products.set(`billing_${plan.id}`, {
      id: `billing_${plan.id}`,
      object: "product",
      name: plan.name,
      tax_code: null,
      metadata: { plan_id: plan.id },
    });
  }
  stripe.prices.push(
    priceJson({
      id: "price_m1",
      lookupKey: monthly.lookupKey,
      product: "billing_monthly",
      planId: "monthly",
      unitAmount: 4900,
      currencyOptions: { USD: 3500, GBP: 3000 },
    }),
    priceJson({
      id: "price_a1",
      lookupKey: annual.lookupKey,
      product: "billing_annual",
      planId: "annual",
      unitAmount: 49_000,
      interval: "year",
    }),
  );
}

/** Stripe holding exactly what `monthly` asks for, so a plan that differs shows one change. */
function matching(stripe: ReturnType<typeof createFakeStripe>) {
  synced(stripe);
  stripe.prices.splice(
    0,
    1,
    priceJson({
      id: "price_m1",
      lookupKey: monthly.lookupKey,
      product: "billing_monthly",
      planId: "monthly",
      unitAmount: 4900,
      currencyOptions: { USD: 3500, NZD: 5200 },
    }),
  );
}

describe("syncPlans", () => {
  it("reports a multi-currency diff on a dry run and sends nothing", async () => {
    const { stripe, request } = setup();
    synced(stripe);
    // The code now says USD 3500 (same), NZD 5200 (new), and no GBP.
    const report = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: false }));
    const plan = report.plans.find((p) => p.planId === "monthly")!;
    expect(plan.price.action).toBe("replace");
    expect(plan.price.diffs.toSorted()).toEqual(["GBP: 3000 → removed", "NZD: missing → 5200"]);
    expect(report.plans.find((p) => p.planId === "annual")!.price.action).toBe("ok");
    expect(posts(stripe)).toEqual([]);
  });

  it("reports a changed amount in any currency", async () => {
    const { stripe, request } = setup();
    synced(stripe);
    const repriced = definePlan({
      ...monthly,
      price: { ...monthly.price, amounts: { AUD: 5900, USD: 3500, GBP: 3000 } },
    });
    const report = await Effect.runPromise(
      syncPlans({ plans: [repriced, annual], request, apply: false }),
    );
    expect(report.plans[0]!.price.diffs).toEqual(["AUD: 4900 → 5900"]);
  });

  it("creates product and price on a first apply, with every currency, the tax behaviour and the plan id", async () => {
    const { stripe, request } = setup();
    const taxed = definePlan({ ...monthly, taxCode: "txcd_10103001" });
    const report = await Effect.runPromise(syncPlans({ plans: [taxed], request, apply: true }));
    expect(report.plans[0]!.price.action).toBe("create");
    const product = stripe.callsTo("POST", "/v1/products")[0]!.form;
    expect(product).toEqual({
      id: "billing_monthly",
      name: "Monthly",
      tax_code: "txcd_10103001",
      "metadata[plan_id]": "monthly",
    });
    expect(stripe.callsTo("POST", "/v1/prices")[0]!.form).toEqual({
      product: "billing_monthly",
      currency: "aud",
      unit_amount: "4900",
      "recurring[interval]": "month",
      tax_behavior: "exclusive",
      lookup_key: "workspace_monthly_v1",
      transfer_lookup_key: "true",
      "currency_options[usd][unit_amount]": "3500",
      "currency_options[usd][tax_behavior]": "exclusive",
      "currency_options[nzd][unit_amount]": "5200",
      "currency_options[nzd][tax_behavior]": "exclusive",
      "metadata[plan_id]": "monthly",
    });
  });

  it("moves the lookup key to a new price when an amount changes", async () => {
    const { stripe, request } = setup();
    synced(stripe);
    await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    const created = stripe.callsTo("POST", "/v1/prices");
    expect(created).toHaveLength(1);
    expect(created[0]!.form.transfer_lookup_key).toBe("true");
    expect(stripe.prices.find((p) => p.id === "price_m1")!.lookup_key).toBeNull();
  });

  it("refuses to apply when a product or price it would touch names another plan", async () => {
    const { stripe, request } = setup();
    synced(stripe);
    stripe.prices[0]!.metadata = { plan_id: "someone_elses" };
    const report = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    expect([report.conflicts, report.applied, report.plans[0]!.price.action]).toEqual([
      1,
      false,
      "conflict",
    ]);
    expect(posts(stripe)).toEqual([]);
  });

  it("refuses to apply when a product carries another plan's id", async () => {
    const { stripe, request } = setup();
    matching(stripe);
    (stripe.products.get("billing_monthly")!.metadata as Record<string, string>).plan_id =
      "someone_elses";
    const report = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    expect([report.conflicts, report.applied, report.plans[0]!.product.action]).toEqual([
      1,
      false,
      "conflict",
    ]);
    expect(posts(stripe)).toEqual([]);
  });

  it("plans a replacement price when the tax behaviour changes, and when the interval changes", async () => {
    const { stripe, request } = setup();
    matching(stripe);
    const run = (plan: typeof monthly) =>
      Effect.runPromise(syncPlans({ plans: [plan, annual], request, apply: false }));
    expect((await run(monthly)).plans[0]!.price.action).toBe("ok");

    const inclusive = definePlan({
      ...monthly,
      price: { ...monthly.price, taxBehavior: "inclusive" },
    });
    const tax = (await run(inclusive)).plans[0]!.price;
    expect(tax.action).toBe("replace");
    expect(tax.diffs).toContain("tax_behavior: exclusive → inclusive");

    const yearly = definePlan({ ...monthly, price: { ...monthly.price, interval: "year" } });
    const interval = (await run(yearly)).plans[0]!.price;
    expect(interval.action).toBe("replace");
    expect(interval.diffs).toEqual(["interval: month → year"]);
  });

  it("tags a price that has no plan id, without creating another", async () => {
    const { stripe, request } = setup();
    matching(stripe);
    stripe.prices[0]!.metadata = {};
    const report = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    expect(report.plans[0]!.price.action).toBe("update_metadata");
    expect(stripe.callsTo("POST", "/v1/prices")).toHaveLength(0);
    const [update] = stripe.callsTo("POST", "/v1/prices/price_m1");
    expect(update!.form).toEqual({ "metadata[plan_id]": "monthly" });
  });

  it("renames a product whose plan was renamed", async () => {
    const { stripe, request } = setup();
    matching(stripe);
    const renamed = definePlan({ ...monthly, name: "Monthly Plus" });
    const report = await Effect.runPromise(
      syncPlans({ plans: [renamed, annual], request, apply: true }),
    );
    expect(report.plans[0]!.product.action).toBe("update");
    const updates = stripe.callsTo("POST", "/v1/products/billing_monthly");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.form).toMatchObject({
      name: "Monthly Plus",
      "metadata[plan_id]": "monthly",
    });
    expect(stripe.products.get("billing_monthly")!.name).toBe("Monthly Plus");
  });

  it("finds its portal configuration on a later page, and updates it rather than adding another", async () => {
    const { stripe, request } = setup({ portalPageSize: 1 });
    matching(stripe);
    stripe.portalConfigurations.push(
      { id: "bpc_theirs", metadata: {}, features: {} },
      { id: "bpc_mine", metadata: { managed_by: "billing-sync" }, features: {} },
    );
    const report = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    expect([report.portal.action, report.portal.configurationId]).toEqual(["update", "bpc_mine"]);
    expect(stripe.callsTo("GET", "/v1/billing_portal/configurations")).toHaveLength(2);
    expect(stripe.callsTo("POST", "/v1/billing_portal/configurations")).toHaveLength(0);
    expect(stripe.callsTo("POST", "/v1/billing_portal/configurations/bpc_mine")).toHaveLength(1);
  });

  it("updates the one portal configuration it manages in place, and creates it once", async () => {
    const { stripe, request } = setup();
    synced(stripe);
    stripe.portalConfigurations.push({ id: "bpc_theirs", metadata: {}, features: {} });
    const first = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    expect(first.portal.action).toBe("create");
    expect(stripe.callsTo("POST", "/v1/billing_portal/configurations")[0]!.form).toEqual({
      "features[customer_update][enabled]": "true",
      "features[customer_update][allowed_updates][0]": "address",
      "features[customer_update][allowed_updates][1]": "tax_id",
      "features[invoice_history][enabled]": "true",
      "features[payment_method_update][enabled]": "true",
      "features[subscription_cancel][enabled]": "true",
      "features[subscription_cancel][mode]": "at_period_end",
      "features[subscription_update][enabled]": "false",
      "metadata[managed_by]": "billing-sync",
    });
    const managed = stripe.portalConfigurations.find((p) => p.id === first.portal.configurationId)!;
    managed.features = { invoice_history: { enabled: false } };
    const second = await Effect.runPromise(syncPlans({ plans: PLANS, request, apply: true }));
    expect([second.portal.action, second.portal.configurationId]).toEqual([
      "update",
      first.portal.configurationId,
    ]);
    expect(stripe.callsTo("POST", "/v1/billing_portal/configurations")).toHaveLength(1);
    expect(
      stripe.callsTo("POST", `/v1/billing_portal/configurations/${first.portal.configurationId}`),
    ).toHaveLength(1);
  });
});
