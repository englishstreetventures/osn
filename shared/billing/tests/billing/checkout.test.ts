import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { subscriptionWrite } from "../storage/contract";
import { createHarness, flip, run } from "../support/billing";
import { priceJson } from "../support/fake-stripe";

const input = (over: Partial<{ planId: "monthly" | "annual"; currency: string }> = {}) => ({
  customerRef: "org_1",
  planId: "monthly" as const,
  currency: "AUD",
  successUrl: "https://app.example.test/billing/done",
  cancelUrl: "https://app.example.test/billing",
  ...over,
});

const TAX_ON = { automatic: true, collectTaxIds: true, requireTaxId: true };

describe("checkout", () => {
  it("sends the subscription form Stripe Tax needs", async () => {
    const h = await createHarness({ tax: TAX_ON });
    const result = await run(h.billing.checkout(input({ currency: "usd" })));
    expect(result.reused).toBe(false);
    const [call] = h.stripe.callsTo("POST", "/v1/checkout/sessions");
    const customer = (await run(h.storage.findCustomer("org_1")))!;
    expect(call!.form).toEqual({
      mode: "subscription",
      customer: customer.providerCustomerId,
      client_reference_id: customer.id,
      "line_items[0][price]": "price_monthly",
      "line_items[0][quantity]": "1",
      currency: "usd",
      success_url: "https://app.example.test/billing/done",
      cancel_url: "https://app.example.test/billing",
      "subscription_data[trial_period_days]": "30",
      "automatic_tax[enabled]": "true",
      "tax_id_collection[enabled]": "true",
      "tax_id_collection[required]": "if_supported",
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
    });
    expect(result.url).toBe(
      `https://checkout.stripe.test/${h.stripe.sessions.keys().next().value}`,
    );
  });

  it("sends no tax parameters when tax is off", async () => {
    const h = await createHarness();
    await run(h.billing.checkout(input()));
    const form = h.stripe.callsTo("POST", "/v1/checkout/sessions")[0]!.form;
    expect(Object.keys(form).filter((k) => /tax|customer_update/.test(k))).toEqual([]);
  });

  it("offers no second trial, unless the policy allows one", async () => {
    const h = await createHarness();
    const customer = await run(h.storage.ensureCustomer("org_1", h.now()));
    await run(h.storage.markTrialUsed(customer.id, h.now()));
    await run(h.billing.checkout(input()));
    expect(
      h.stripe.callsTo("POST", "/v1/checkout/sessions")[0]!.form[
        "subscription_data[trial_period_days]"
      ],
    ).toBeUndefined();

    const lenient = await createHarness({ policy: { oneTrialPerCustomer: false } });
    const again = await run(lenient.storage.ensureCustomer("org_1", lenient.now()));
    await run(lenient.storage.markTrialUsed(again.id, lenient.now()));
    await run(lenient.billing.checkout(input()));
    expect(
      lenient.stripe.callsTo("POST", "/v1/checkout/sessions")[0]!.form[
        "subscription_data[trial_period_days]"
      ],
    ).toBe("30");
  });

  it("refuses a currency the price does not offer, before any session exists", async () => {
    const h = await createHarness();
    const error = await flip(h.billing.checkout(input({ currency: "GBP" })));
    expect([error._tag, h.stripe.callsTo("POST", "/v1/checkout/sessions").length]).toEqual([
      "CurrencyNotOffered",
      0,
    ]);
  });

  it("refuses a plan id no plan declares, with a typed error", async () => {
    const h = await createHarness();
    const error = await flip(h.billing.checkout(input({ planId: "gone" as "monthly" })));
    expect([error._tag, h.stripe.calls.length]).toEqual(["UnknownPlan", 0]);
  });

  it.each(["frozen", "incomplete"])(
    "counts a stored %s subscription as live, so a second one in the group is refused",
    async (status) => {
      const h = await createHarness();
      await run(h.storage.ensureCustomer("org_1", h.now()));
      await run(
        h.storage.upsertSubscription(
          subscriptionWrite({ planId: "monthly", status, fetchStartedAt: h.now() }),
          h.now(),
        ),
      );
      expect((await flip(h.billing.checkout(input({ planId: "annual" }))))._tag).toBe(
        "AlreadySubscribed",
      );
    },
  );

  it("refuses a second live subscription in the group, and allows one after it ends", async () => {
    const h = await createHarness();
    await run(h.storage.ensureCustomer("org_1", h.now()));
    await run(
      h.storage.upsertSubscription(
        subscriptionWrite({ planId: "monthly", status: "past_due", fetchStartedAt: h.now() }),
        h.now(),
      ),
    );
    expect((await flip(h.billing.checkout(input({ planId: "annual" }))))._tag).toBe(
      "AlreadySubscribed",
    );
    await run(
      h.storage.upsertSubscription(
        subscriptionWrite({ status: "canceled", fetchStartedAt: new Date(h.now().getTime() + 1) }),
        h.now(),
      ),
    );
    expect((await run(h.billing.checkout(input({ planId: "annual" })))).reused).toBe(false);
  });

  it("reuses an open session for the same plan and currency", async () => {
    const h = await createHarness();
    const first = await run(h.billing.checkout(input()));
    const second = await run(h.billing.checkout(input()));
    expect([
      second.url,
      second.reused,
      h.stripe.callsTo("POST", "/v1/checkout/sessions").length,
    ]).toEqual([first.url, true, 1]);
  });

  it("expires the open session when the plan or currency changes, and keys the new one with a new nonce", async () => {
    const h = await createHarness();
    const first = await run(h.billing.checkout(input()));
    const second = await run(h.billing.checkout(input({ currency: "NZD" })));
    const creates = h.stripe.callsTo("POST", "/v1/checkout/sessions");
    expect(second.url).not.toBe(first.url);
    expect(h.stripe.callsTo("POST", /\/expire$/)).toHaveLength(1);
    expect([...h.stripe.sessions.values()].map((s) => s.status)).toEqual(["expired", "open"]);
    const keys = creates.map((c) => c.headers.get("idempotency-key"));
    const customer = (await run(h.storage.findCustomer("org_1")))!;
    expect(keys.every((k) => k?.startsWith(`billing-checkout-${customer.id}-`))).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  it("answers in-flight while a completed session waits for its webhook, and when expiry loses to completion", async () => {
    const h = await createHarness();
    await run(h.billing.checkout(input()));
    const session = [...h.stripe.sessions.values()][0]!;
    session.status = "complete";
    expect((await flip(h.billing.checkout(input())))._tag).toBe("CheckoutInFlight");

    const g = await createHarness();
    await run(g.billing.checkout(input()));
    // The buyer pays between our read and our expire.
    g.stripe.setIntercept((call) => {
      if (call.path.endsWith("/expire")) {
        [...g.stripe.sessions.values()][0]!.status = "complete";
        return Response.json({ error: { code: "checkout_session_not_open" } }, { status: 400 });
      }
      return undefined;
    });
    expect((await flip(g.billing.checkout(input({ currency: "USD" }))))._tag).toBe(
      "CheckoutInFlight",
    );
    expect(g.stripe.callsTo("POST", "/v1/checkout/sessions")).toHaveLength(1);
    const restored = (await run(g.storage.findCustomer("org_1")))!.pendingCheckout;
    expect([restored?.currency, restored?.sessionId]).toEqual([
      "AUD",
      [...g.stripe.sessions.keys()][0],
    ]);
    g.stripe.setIntercept(() => undefined);
    expect((await flip(g.billing.checkout(input({ currency: "USD" }))))._tag).toBe(
      "CheckoutInFlight",
    );
  });

  it("makes one session for two concurrent identical requests", async () => {
    const h = await createHarness();
    const [a, b] = await Promise.all([
      run(h.billing.checkout(input())),
      run(h.billing.checkout(input())),
    ]);
    expect(a.url).toBe(b.url);
    expect(h.stripe.callsTo("POST", "/v1/checkout/sessions")).toHaveLength(1);
    expect(h.stripe.callsTo("POST", "/v1/customers").length).toBeGreaterThanOrEqual(1);
    expect(
      new Set(
        h.stripe.callsTo("POST", "/v1/customers").map((c) => c.headers.get("idempotency-key")),
      ).size,
    ).toBe(1);
  });

  it("waits out a young pending nonce and replaces a stale one", async () => {
    const h = await createHarness();
    const customer = await run(h.storage.ensureCustomer("org_1", h.now()));
    await run(
      h.storage.claimCheckout({
        customerId: customer.id,
        expectedNonce: null,
        nonce: "other",
        planId: "monthly",
        currency: "AUD",
        now: h.now(),
      }),
    );
    expect((await flip(h.billing.checkout(input())))._tag).toBe("CheckoutInFlight");
    h.advance(61_000);
    expect((await run(h.billing.checkout(input()))).reused).toBe(false);
    expect((await run(h.storage.findCustomer("org_1")))!.pendingCheckout?.nonce).not.toBe("other");
  });

  it("expires a session it could not record, and never hands out its URL", async () => {
    const h = await createHarness();
    h.stripe.setIntercept((call) => {
      if (call.method === "POST" && call.path === "/v1/checkout/sessions") {
        // Another request moves the nonce while this create is in flight.
        void run(
          Effect.gen(function* () {
            const customer = (yield* h.storage.findCustomer("org_1"))!;
            yield* h.storage.claimCheckout({
              customerId: customer.id,
              expectedNonce: customer.pendingCheckout!.nonce,
              nonce: "usurper",
              planId: "annual",
              currency: "AUD",
              now: h.now(),
            });
          }),
        );
      }
      return undefined;
    });
    expect((await flip(h.billing.checkout(input())))._tag).toBe("CheckoutInFlight");
    expect([...h.stripe.sessions.values()].map((s) => s.status)).toEqual(["expired"]);
  });

  it("frees the checkout slot when the session cannot be created, so the next click works", async () => {
    const h = await createHarness();
    let failed = false;
    h.stripe.setIntercept((call) => {
      if (call.method === "POST" && call.path === "/v1/checkout/sessions" && !failed) {
        failed = true;
        return new Response("boom", { status: 500 });
      }
      return undefined;
    });
    const error = await flip(h.billing.checkout(input()));
    expect([error._tag, (await run(h.storage.findCustomer("org_1")))!.pendingCheckout]).toEqual([
      "BillingProviderError",
      null,
    ]);
    expect((await run(h.billing.checkout(input()))).reused).toBe(false);
  });

  it("creates the Stripe customer under a stable key with stable parameters only", async () => {
    const h = await createHarness();
    await run(h.billing.checkout(input()));
    const [call] = h.stripe.callsTo("POST", "/v1/customers");
    const customer = (await run(h.storage.findCustomer("org_1")))!;
    expect(call!.headers.get("idempotency-key")).toBe(`billing-customer-${customer.id}`);
    expect(call!.form).toEqual({ "metadata[billing_customer]": customer.id });
  });

  it("replays the customer create when Stripe says the key is in use", async () => {
    const h = await createHarness();
    let refused = false;
    h.stripe.setIntercept((call) => {
      if (call.path === "/v1/customers" && !refused) {
        refused = true;
        return Response.json({ error: { code: "idempotency_key_in_use" } }, { status: 409 });
      }
      return undefined;
    });
    expect((await run(h.billing.checkout(input()))).reused).toBe(false);
    expect(h.stripe.callsTo("POST", "/v1/customers")).toHaveLength(2);
  });

  it("refuses to sell a plan whose price names another plan", async () => {
    const h = await createHarness();
    h.stripe.prices[0]!.metadata = { plan_id: "annual" };
    const error = await flip(h.billing.checkout(input()));
    expect([error._tag, "reason" in error ? error.reason : null]).toEqual([
      "PlanUnavailable",
      "mismatched",
    ]);
  });
});

describe("which price a plan is sold at", () => {
  it("does not sell a price with no plan_id that another product holds under the lookup key", async () => {
    const h = await createHarness();
    h.stripe.prices[0]!.metadata = {};
    h.stripe.prices[0]!.product = "prod_other";
    const error = await flip(h.billing.checkout(input()));
    expect([error._tag, "reason" in error ? error.reason : null]).toEqual([
      "PlanUnavailable",
      "mismatched",
    ]);
  });

  it("sells a price with no plan_id when it hangs off the plan's own product", async () => {
    const h = await createHarness();
    h.stripe.prices[0]!.metadata = {};
    expect((await run(h.billing.checkout(input()))).reused).toBe(false);
  });

  it("says missing when no price sits under the lookup key", async () => {
    const h = await createHarness();
    h.stripe.prices.splice(0, 1);
    const error = await flip(h.billing.checkout(input()));
    expect([error._tag, "reason" in error ? error.reason : null]).toEqual([
      "PlanUnavailable",
      "missing",
    ]);
  });
});

describe("tax options", () => {
  it("refuses to create billing that requires tax ids without collecting them", async () => {
    await expect(
      createHarness({ tax: { automatic: false, collectTaxIds: false, requireTaxId: true } }),
    ).rejects.toThrow(/requireTaxId needs tax.collectTaxIds/);
  });
});

describe("catalogue", () => {
  it("reads prices from Stripe once per TTL, with every currency and the tax behaviour", async () => {
    const h = await createHarness();
    const entries = await run(h.billing.catalogue());
    expect(entries.find((e) => e.planId === "monthly")).toMatchObject({
      available: true,
      priceId: "price_monthly",
      interval: "month",
      taxBehavior: "exclusive",
      defaultCurrency: "AUD",
      prices: [
        { currency: "AUD", unitAmount: 4900 },
        { currency: "USD", unitAmount: 3500 },
        { currency: "NZD", unitAmount: 5200 },
      ],
    });
    await run(h.billing.catalogue());
    expect(h.stripe.callsTo("GET", "/v1/prices")).toHaveLength(1);
    h.advance(10 * 60_000);
    await run(h.billing.catalogue());
    expect(h.stripe.callsTo("GET", "/v1/prices")).toHaveLength(2);
  });

  it("asks for at most ten lookup keys per call", async () => {
    const { createBilling, definePlan, defineFeature } = await import("../../src");
    const { createStripeProvider } = await import("../../src/stripe");
    const h = await createHarness();
    const feature = defineFeature({ id: "f" });
    const plans = Array.from({ length: 12 }, (_, i) =>
      definePlan({
        id: `p${i}`,
        name: `P${i}`,
        group: `g${i}`,
        lookupKey: `k${i}`,
        features: [feature],
        price: {
          interval: "month",
          defaultCurrency: "AUD",
          amounts: { AUD: 100 },
          taxBehavior: "exclusive",
        },
      }),
    );
    for (const plan of plans)
      h.stripe.prices.push(
        priceJson({
          id: `price_${plan.id}`,
          lookupKey: plan.lookupKey,
          product: `billing_${plan.id}`,
          planId: plan.id,
        }),
      );
    const billing = createBilling({
      plans,
      storage: h.storage,
      provider: createStripeProvider({
        secretKey: "sk",
        webhookSecret: null,
        fetchImpl: h.stripe.fetchImpl,
      }),
    });
    const entries = await run(billing.catalogue());
    const calls = h.stripe.callsTo("GET", "/v1/prices");
    expect(
      calls.map((c) => [...c.query.keys()].filter((k) => k.startsWith("lookup_keys")).length),
    ).toEqual([10, 2]);
    expect(entries.every((e) => e.available)).toBe(true);
  });
});

describe("portal", () => {
  it("opens a portal session for the customer's Stripe customer", async () => {
    const h = await createHarness();
    await run(h.billing.checkout(input()));
    const { url } = await run(
      h.billing.portal({ customerRef: "org_1", returnUrl: "https://app.example.test/billing" }),
    );
    const [call] = h.stripe.callsTo("POST", "/v1/billing_portal/sessions");
    const customer = (await run(h.storage.findCustomer("org_1")))!;
    expect(url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    expect(call!.form).toEqual({
      customer: customer.providerCustomerId,
      return_url: "https://app.example.test/billing",
    });
  });

  it("refuses a customer who never reached checkout", async () => {
    const h = await createHarness();
    expect(
      (await flip(h.billing.portal({ customerRef: "org_9", returnUrl: "https://x.test" })))._tag,
    ).toBe("NoBillingCustomer");
  });
});
