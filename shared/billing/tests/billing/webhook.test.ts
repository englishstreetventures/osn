import { inspect } from "node:util";

import { Effect, Logger, References } from "effect";
import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";

import { BillingStorageError } from "../../src/errors";
import { billingWebhookRoute } from "../../src/http/elysia";
import { MAX_EVENT_BYTES } from "../../src/http/webhook-body";
import { subscriptionWrite } from "../storage/contract";
import { createHarness, DAY, flip, run, T0, unix } from "../support/billing";
import {
  invoiceJson,
  signedBody,
  signedEvent,
  subscriptionJson,
  type FakeSubscriptionInput,
} from "../support/fake-stripe";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const PERIOD_START = unix(T0) - 5 * 86_400;
const PERIOD_END = PERIOD_START + 30 * 86_400;

async function customerWithStripe(h: Harness, ref = "org_1", stripeId = "cus_1") {
  const customer = await run(h.storage.ensureCustomer(ref, h.now()));
  await run(h.storage.setProviderCustomerId(customer.id, stripeId));
  return customer;
}

function stripeHas(h: Harness, over: Partial<FakeSubscriptionInput> = {}) {
  const sub = subscriptionJson({
    id: "sub_1",
    customer: "cus_1",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...over,
  });
  h.stripe.subscriptions.set(String(sub.id), sub);
  return sub;
}

const deliver = async (h: Harness, event: Parameters<typeof signedEvent>[0]) =>
  run(h.billing.handleWebhook(await signedEvent(event, h.now())));

/** The customer starts a checkout that has made session `cs_1`. */
async function withPendingCheckout(h: Harness) {
  const customer = await customerWithStripe(h);
  await run(
    h.storage.claimCheckout({
      customerId: customer.id,
      expectedNonce: null,
      nonce: "n1",
      planId: "monthly",
      currency: "AUD",
      now: h.now(),
    }),
  );
  await run(
    h.storage.setCheckoutSession({ customerId: customer.id, nonce: "n1", sessionId: "cs_1" }),
  );
  return customer;
}

const sessionObject = (over: Record<string, unknown> = {}) => ({
  id: "cs_1",
  mode: "subscription",
  status: "complete",
  customer: "cus_1",
  subscription: "sub_1",
  url: null,
  ...over,
});

/** Whether the event is still unrecorded: only a delivery that stopped before the claim leaves it so. */
const neverClaimed = (h: Harness, eventId: string) =>
  run(
    h.storage.claimEvent({
      eventId,
      type: "any",
      now: h.now(),
      leaseUntil: new Date(h.now().getTime() + 60_000),
    }),
  );

const subEvent = (
  id: string,
  object: Record<string, unknown> = { id: "sub_1" },
  type = "customer.subscription.updated",
) => ({
  id,
  type,
  object,
});

describe("handleWebhook", () => {
  it("refuses a body over 64 KB, declared or streamed", async () => {
    const h = await createHarness();
    const declared = new Request("https://x.test/hook", {
      method: "POST",
      headers: { "content-length": String(65 * 1024) },
      body: "{}",
    });
    const streamed = new Request("https://x.test/hook", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(70 * 1024));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    for (const request of [declared, streamed]) {
      expect((await run(h.billing.handleWebhook(request))).status).toBe(400);
    }
  });

  it("does not refuse a body that declares exactly 64 KB", async () => {
    const h = await createHarness();
    const request = new Request("https://x.test/hook", {
      method: "POST",
      headers: { "content-length": String(MAX_EVENT_BYTES) },
      body: "{}",
    });
    const result = await run(h.billing.handleWebhook(request));
    expect(result.body.outcome).not.toBe("too_large");
  });

  it("refuses a delivery whose signature does not verify", async () => {
    const h = await createHarness();
    const forged = await signedEvent(subEvent("evt_1"), h.now(), "whsec_wrong");
    const result = await run(h.billing.handleWebhook(forged));
    expect([result.status, result.body.outcome]).toEqual([400, "invalid_signature"]);
  });

  it("refuses a Connect event without fetching or writing anything", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    const result = await deliver(h, { ...subEvent("evt_1"), account: "acct_123" });
    expect([result.status, result.body.outcome, h.stripe.calls.length]).toEqual([
      200,
      "refused_connect",
      0,
    ]);
    expect(await run(h.storage.findSubscription("sub_1"))).toBeNull();
    expect(await neverClaimed(h, "evt_1")).toBe("claimed");
  });

  it("acts on a delivery once: a duplicate is answered without re-fetching", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    expect((await deliver(h, subEvent("evt_1"))).body.outcome).toBe("processed");
    const fetches = h.stripe.calls.length;
    const again = await deliver(h, subEvent("evt_1"));
    expect([again.status, again.body.outcome, h.stripe.calls.length]).toEqual([
      200,
      "duplicate",
      fetches,
    ]);
  });

  it("answers 500 while another delivery holds the claim, and takes over an expired claim", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    await run(
      h.storage.claimEvent({
        eventId: "evt_1",
        type: "customer.subscription.updated",
        now: h.now(),
        leaseUntil: new Date(h.now().getTime() + 60_000),
      }),
    );
    expect((await deliver(h, subEvent("evt_1"))).status).toBe(500);
    h.advance(61_000);
    expect((await deliver(h, subEvent("evt_1"))).body.outcome).toBe("processed");
  });

  it("stores what Stripe says now, not what the event carried, with the period from the item", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h, { status: "canceled" });
    await deliver(h, subEvent("evt_1", { id: "sub_1", status: "active" }));
    const stored = (await run(h.storage.findSubscription("sub_1")))!;
    expect([
      stored.status,
      stored.currentPeriodStart,
      stored.currentPeriodEnd,
      stored.currency,
      stored.interval,
    ]).toEqual([
      "canceled",
      new Date(PERIOD_START * 1000),
      new Date(PERIOD_END * 1000),
      "AUD",
      "month",
    ]);
  });

  it("maps a price to its plan by metadata, then by product, never by lookup key alone", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h, { planId: null, product: "billing_annual" });
    await deliver(h, subEvent("evt_1"));
    expect((await run(h.storage.findSubscription("sub_1")))!.planId).toBe("annual");

    stripeHas(h, {
      id: "sub_2",
      planId: null,
      product: "prod_somebody_else",
      priceId: "price_monthly",
    });
    const result = await deliver(h, subEvent("evt_2", { id: "sub_2" }));
    expect([result.body.outcome, await run(h.storage.findSubscription("sub_2"))]).toEqual([
      "ignored",
      null,
    ]);
  });

  it("never lets a slow fetch of older state overwrite a newer one", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h, { status: "active" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const slowFetchReached = new Promise<void>((resolve) => (reached = resolve));
    let first = true;
    h.stripe.setIntercept(async (call) => {
      if (call.path === "/v1/subscriptions/sub_1" && first) {
        first = false;
        // The slow delivery has taken its `fetchStartedAt` once this call arrives.
        reached();
        // The first fetch reads `active`, then stalls past the second.
        const stale = Response.json(
          subscriptionJson({
            id: "sub_1",
            customer: "cus_1",
            status: "active",
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
          }),
        );
        await gate;
        return stale;
      }
      return undefined;
    });
    const slow = deliver(h, subEvent("evt_old"));
    await slowFetchReached;
    h.advance(1_000);
    stripeHas(h, { status: "canceled" });
    await deliver(h, subEvent("evt_new"));
    release();
    await slow;
    expect((await run(h.storage.findSubscription("sub_1")))!.status).toBe("canceled");
  });

  it("answers 500 and releases the claim on a storage failure, so the redelivery is processed", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    const upsert = h.storage.upsertSubscription;
    let broken = true;
    (h.storage as { upsertSubscription: typeof upsert }).upsertSubscription = (write, now) =>
      broken ? Effect.die(new Error("disk")) : upsert(write, now);
    expect((await deliver(h, subEvent("evt_1"))).status).toBe(500);
    broken = false;
    expect((await deliver(h, subEvent("evt_1"))).body.outcome).toBe("processed");
  });

  it("answers 500 when Stripe fails", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    h.stripe.setIntercept(() => new Response("bad gateway", { status: 502 }));
    expect((await deliver(h, subEvent("evt_1"))).status).toBe(500);
  });

  it("acknowledges an event type it does not handle, and a one-off payment session", async () => {
    const h = await createHarness();
    expect(
      (await deliver(h, { id: "evt_1", type: "charge.refunded", object: { id: "ch_1" } })).body
        .outcome,
    ).toBe("ignored");
    const payment = await deliver(h, {
      id: "evt_2",
      type: "checkout.session.completed",
      object: {
        id: "cs_1",
        mode: "payment",
        status: "complete",
        customer: "cus_1",
        subscription: null,
        url: null,
      },
    });
    expect([payment.status, payment.body.outcome, h.stripe.calls.length]).toEqual([
      200,
      "ignored",
      0,
    ]);
    expect(await neverClaimed(h, "evt_2")).toBe("claimed");
  });

  it("stores the subscription from a completed checkout, then clears the pending session", async () => {
    const h = await createHarness();
    await withPendingCheckout(h);
    stripeHas(h, { status: "trialing", trialEnd: unix(T0) + 30 * 86_400 });
    await deliver(h, {
      id: "evt_1",
      type: "checkout.session.completed",
      object: sessionObject(),
    });
    const after = (await run(h.storage.findCustomer("org_1")))!;
    expect([
      (await run(h.storage.findSubscription("sub_1")))?.status,
      after.pendingCheckout,
      after.trialUsedAt,
    ]).toEqual(["trialing", null, h.now()]);
  });

  it("ignores a subscription whose Stripe customer is not one of ours", async () => {
    const h = await createHarness();
    stripeHas(h, { customer: "cus_stranger" });
    const result = await deliver(h, subEvent("evt_1"));
    expect([result.status, result.body.outcome]).toEqual([200, "ignored"]);
  });

  it("calls onAccess on every delivery, with the current decision", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    await deliver(h, subEvent("evt_1"));
    await deliver(h, subEvent("evt_2"));
    expect(h.decisions.map((d) => d.features.workspace.allowed)).toEqual([true, true]);
    expect(h.decisions[1]!.version).toBeGreaterThan(h.decisions[0]!.version);
  });

  it("answers 500 and releases the claim when the access lease stays busy", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    await run(
      h.storage.acquireAccess({
        customerRef: "org_1",
        now: h.now(),
        until: new Date(h.now().getTime() + 30_000),
      }),
    );
    expect((await deliver(h, subEvent("evt_1"))).status).toBe(500);
    h.advance(31_000);
    expect((await deliver(h, subEvent("evt_1"))).body.outcome).toBe("processed");
    expect(h.decisions.at(-1)!.features.workspace.allowed).toBe(true);
  });

  it.each(["created", "updated", "deleted", "paused", "resumed", "trial_will_end"] as const)(
    "re-fetches and stores the subscription on customer.subscription.%s",
    async (kind) => {
      const h = await createHarness();
      await customerWithStripe(h);
      stripeHas(h, { status: "unpaid" });
      const result = await deliver(
        h,
        subEvent("evt_1", { id: "sub_1" }, `customer.subscription.${kind}`),
      );
      expect([result.status, result.body.outcome]).toEqual([200, "processed"]);
      expect((await run(h.storage.findSubscription("sub_1")))!.status).toBe("unpaid");
    },
  );

  it("starts the grace clock on invoice.payment_failed, from what Stripe says now", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h, { status: "past_due" });
    const result = await deliver(h, {
      id: "evt_1",
      type: "invoice.payment_failed",
      object: invoiceJson({
        id: "in_f",
        subscription: "sub_1",
        status: "open",
        lines: [{ amount: 4900, start: PERIOD_START, end: PERIOD_END }],
      }),
    });
    const stored = (await run(h.storage.findSubscription("sub_1")))!;
    expect([result.body.outcome, stored.status, stored.pastDueSince]).toEqual([
      "processed",
      "past_due",
      h.now(),
    ]);
    expect(await run(h.billing.check("org_1", "workspace"))).toMatchObject({
      allowed: true,
      reason: "grace",
      status: "past_due",
    });
  });

  it("clears the pending checkout when its session expires", async () => {
    const h = await createHarness();
    await withPendingCheckout(h);
    expect((await run(h.storage.findCustomer("org_1")))!.pendingCheckout?.sessionId).toBe("cs_1");
    const result = await deliver(h, {
      id: "evt_1",
      type: "checkout.session.expired",
      object: sessionObject({ status: "expired", subscription: null }),
    });
    expect([
      result.body.outcome,
      (await run(h.storage.findCustomer("org_1")))!.pendingCheckout,
    ]).toEqual(["processed", null]);
  });

  it("keeps the pending session when the subscription cannot be stored, so no second checkout starts", async () => {
    const h = await createHarness();
    await withPendingCheckout(h);
    stripeHas(h);
    h.stripe.sessions.set("cs_1", {
      ...sessionObject(),
      object: "checkout.session",
    });
    h.stripe.setIntercept((call) =>
      call.path === "/v1/subscriptions/sub_1" ? new Response("down", { status: 502 }) : undefined,
    );
    const result = await deliver(h, {
      id: "evt_1",
      type: "checkout.session.completed",
      object: sessionObject(),
    });
    expect(result.status).toBe(500);
    expect((await run(h.storage.findCustomer("org_1")))!.pendingCheckout?.sessionId).toBe("cs_1");
    const second = await flip(
      h.billing.checkout({
        customerRef: "org_1",
        planId: "monthly",
        currency: "AUD",
        successUrl: "https://app.example.test/done",
        cancelUrl: "https://app.example.test/billing",
      }),
    );
    expect(second._tag).toBe("CheckoutInFlight");
  });

  it("answers 400 to a signed body that is not an event", async () => {
    const h = await createHarness();
    const result = await run(h.billing.handleWebhook(await signedBody('{"hello":1}', h.now())));
    expect([result.status, result.body.outcome, result.body.reason]).toEqual([
      400,
      "invalid_signature",
      "malformed",
    ]);
  });

  it("acknowledges a subscription Stripe no longer has", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    const result = await deliver(h, subEvent("evt_1", { id: "sub_gone" }));
    expect([result.status, result.body.outcome]).toEqual([200, "ignored"]);
  });

  it("answers 500 when the claim cannot be recorded", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    (h.storage as { claimEvent: unknown }).claimEvent = () =>
      Effect.fail(new BillingStorageError({ operation: "claimEvent", message: "disk" }));
    const result = await deliver(h, subEvent("evt_1"));
    expect([result.status, result.body.outcome]).toEqual([500, "error"]);
  });

  it("answers 500 when the finished event cannot be recorded", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    (h.storage as { finishEvent: unknown }).finishEvent = () =>
      Effect.fail(new BillingStorageError({ operation: "finishEvent", message: "disk" }));
    const result = await deliver(h, subEvent("evt_1"));
    expect([result.status, result.body.outcome]).toEqual([500, "error"]);
  });
});

describe("failure logs", () => {
  it("carry no body, signature or secret, from a failed delivery or a failed reconcile", async () => {
    const entries: string[] = [];
    const capture = Logger.layer([
      Logger.make(({ message, fiber }) => {
        entries.push(
          inspect([message, fiber.getRef(References.CurrentLogAnnotations)], { depth: 8 }),
        );
      }),
    ]);
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    const upsert = h.storage.upsertSubscription;
    (h.storage as { upsertSubscription: typeof upsert }).upsertSubscription = () =>
      Effect.die(new Error("disk"));
    const delivery = await signedEvent(subEvent("evt_1"), h.now());
    const signature = delivery.headers.get("stripe-signature")!;
    const body = await delivery.clone().text();
    const failed = await Effect.runPromise(
      h.billing.handleWebhook(delivery).pipe(Effect.provide(capture)),
    );
    expect(failed.status).toBe(500);

    // A row due for reconcile whose Stripe call fails with a secret in its reply.
    (h.storage as { upsertSubscription: typeof upsert }).upsertSubscription = upsert;
    await run(
      h.storage.upsertSubscription(
        subscriptionWrite({
          providerSubscriptionId: "sub_1",
          currentPeriodEnd: new Date(h.now().getTime() - DAY),
          fetchStartedAt: h.now(),
        }),
        h.now(),
      ),
    );
    h.stripe.setIntercept(
      () => new Response("sk_test_harness whsec_billing_test", { status: 503 }),
    );
    const report = await Effect.runPromise(
      h.billing.reconcile({ limit: 10 }).pipe(Effect.provide(capture)),
    );
    expect(report.failed).toBe(1);

    expect(entries.length).toBeGreaterThanOrEqual(2);
    const logged = entries.join("\n");
    for (const secret of [body, signature, "sk_test_harness", "whsec_billing_test"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("paid periods", () => {
  const invoicePaid = (h: Harness, id: string, invoice: Record<string, unknown>) =>
    deliver(h, { id, type: "invoice.paid", object: invoice });

  it("confirms a renewal's period, and status shows it current", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    await invoicePaid(
      h,
      "evt_1",
      invoiceJson({
        id: "in_1",
        subscription: "sub_1",
        lines: [{ amount: 4900, start: PERIOD_START, end: PERIOD_END }],
      }),
    );
    const [sub] = (await run(h.billing.status("org_1"))).subscriptions;
    expect([sub!.paidPeriod, sub!.currentPeriodPaid, sub!.interval]).toEqual([
      {
        id: `sub_1:${PERIOD_START}`,
        start: new Date(PERIOD_START * 1000),
        end: new Date(PERIOD_END * 1000),
      },
      true,
      "month",
    ]);
    expect([sub!.currentPeriod, sub!.group]).toEqual([
      { start: new Date(PERIOD_START * 1000), end: new Date(PERIOD_END * 1000) },
      "workspace",
    ]);
  });

  it("confirms nothing for a trial, a 100%-off invoice, a proration, or a reason that is no period", async () => {
    const cases = [
      // A trial: the subscription line is 0, even beside a paid one-off item.
      invoiceJson({
        id: "in_t",
        subscription: "sub_1",
        billingReason: "subscription_create",
        lines: [
          { amount: 0, start: PERIOD_START, end: PERIOD_END },
          { amount: 1500, start: PERIOD_START, end: PERIOD_START, kind: "invoice_item_details" },
        ],
      }),
      // A coupon: the line is pre-discount, the invoice total is 0.
      invoiceJson({
        id: "in_c",
        subscription: "sub_1",
        total: 0,
        lines: [{ amount: 4900, start: PERIOD_START, end: PERIOD_END }],
      }),
      // An upgrade mid-period: proration lines only.
      invoiceJson({
        id: "in_p",
        subscription: "sub_1",
        billingReason: "subscription_update",
        lines: [
          { amount: 2100, start: PERIOD_START + 10 * 86_400, end: PERIOD_END, proration: true },
        ],
      }),
      // Paid, positive, not a proration: only its reason keeps it from a period.
      invoiceJson({
        id: "in_m",
        subscription: "sub_1",
        billingReason: "manual",
        lines: [{ amount: 4900, start: PERIOD_START, end: PERIOD_END }],
      }),
    ];
    for (const [i, invoice] of cases.entries()) {
      const h = await createHarness();
      await customerWithStripe(h);
      stripeHas(h);
      await invoicePaid(h, `evt_${i}`, invoice);
      const [sub] = (await run(h.billing.status("org_1"))).subscriptions;
      expect([sub!.paidPeriod, sub!.currentPeriodPaid]).toEqual([null, false]);
    }
  });

  it("confirms the full period an early trial end bills, though Stripe calls it an update", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    await invoicePaid(
      h,
      "evt_1",
      invoiceJson({
        id: "in_1",
        subscription: "sub_1",
        billingReason: "subscription_update",
        lines: [{ amount: 4900, start: PERIOD_START, end: PERIOD_END }],
      }),
    );
    expect((await run(h.billing.status("org_1"))).subscriptions[0]!.currentPeriodPaid).toBe(true);
  });

  it("leaves a renewal unconfirmed until its invoice is paid", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    await invoicePaid(
      h,
      "evt_1",
      invoiceJson({
        id: "in_1",
        subscription: "sub_1",
        lines: [{ amount: 4900, start: PERIOD_START, end: PERIOD_END }],
      }),
    );
    // The period rolls over; the renewal invoice is still a draft.
    stripeHas(h, { periodStart: PERIOD_END, periodEnd: PERIOD_END + 30 * 86_400 });
    await deliver(h, subEvent("evt_2"));
    const [sub] = (await run(h.billing.status("org_1"))).subscriptions;
    expect([sub!.currentPeriodPaid, sub!.paidPeriod?.end, sub!.status]).toEqual([
      false,
      new Date(PERIOD_END * 1000),
      "active",
    ]);
  });
});

describe("billingWebhookRoute", () => {
  it("hands the raw body to verification even when it is sent as JSON", async () => {
    const h = await createHarness();
    await customerWithStripe(h);
    stripeHas(h);
    // A hook that reads `body` is what makes the route's `parse` option matter:
    // without it Elysia drains the stream first and the signature has no bytes.
    const app = new Elysia()
      .onBeforeHandle(({ body }) => void body)
      .use(billingWebhookRoute(h.billing, { path: "/billing/webhook", run: Effect.runPromise }));
    const delivery = await signedEvent(subEvent("evt_1"), h.now());
    const response = await app.handle(new Request("http://localhost/billing/webhook", delivery));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome: "processed" });
  });
});
