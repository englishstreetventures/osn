import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { BillingStorage } from "../../src";
import { subscriptionWrite } from "../storage/contract";
import { counting, createHarness, DAY, HOUR, run, T0, unix } from "../support/billing";
import { invoiceJson, subscriptionJson } from "../support/fake-stripe";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const later = (ms: number) => new Date(T0.getTime() + ms);

async function subscribed(h: Harness, ref: string, end: Date, id = `sub_${ref}`) {
  const customer = await run(h.storage.ensureCustomer(ref, h.now()));
  await run(h.storage.setProviderCustomerId(customer.id, `cus_${ref}`));
  await run(
    h.storage.upsertSubscription(
      subscriptionWrite({
        providerSubscriptionId: id,
        customerRef: ref,
        currentPeriodStart: new Date(end.getTime() - 30 * DAY),
        currentPeriodEnd: end,
        fetchStartedAt: h.now(),
      }),
      h.now(),
    ),
  );
  const lease = await run(
    h.storage.acquireAccess({ customerRef: ref, now: h.now(), until: later(1) }),
  );
  await run(
    h.storage.completeAccess({
      customerRef: ref,
      token: later(1),
      version: lease!.version,
      boundary: new Date(end.getTime() + 48 * HOUR),
    }),
  );
}

describe("sweepAccess", () => {
  it("lapses due customers, writes each visited row's next boundary, and reaches the rest on the next run", async () => {
    const h = await createHarness();
    for (const ref of ["org_a", "org_b", "org_c"]) await subscribed(h, ref, later(DAY));
    h.advance(4 * DAY);
    const first = await run(h.billing.sweepAccess({ limit: 2 }));
    expect([first.visited, first.applied]).toEqual([2, 2]);
    expect(h.decisions.map((d) => [d.customerRef, d.features.workspace.allowed])).toEqual([
      ["org_a", false],
      ["org_b", false],
    ]);
    expect((await run(h.storage.findCustomer("org_a")))!.nextAccessBoundaryAt).toBeNull();
    const second = await run(h.billing.sweepAccess({ limit: 2 }));
    expect([second.visited, h.decisions.at(-1)!.customerRef]).toEqual([1, "org_c"]);
  });
});

describe("the fencing token", () => {
  it("lets a hook that fences on decision.version apply a lapse only time caused", async () => {
    // The fence the hook contract documents: write only a larger version.
    const mirror = { appliedVersion: -1, allowed: false };
    const h = await createHarness({
      hooks: {
        onAccess: (decision) =>
          Effect.sync(() => {
            if (mirror.appliedVersion < decision.version) {
              mirror.appliedVersion = decision.version;
              mirror.allowed = decision.features.workspace.allowed;
            }
          }),
      },
    });
    await run(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: later(DAY),
      }),
    );
    expect(mirror.allowed).toBe(true);
    // No write happens; the grant simply runs out.
    h.advance(2 * DAY);
    expect(await run(h.billing.sweepAccess({ limit: 10 }))).toMatchObject({ applied: 1 });
    expect(mirror.allowed).toBe(false);
  });
});

describe("reconcile", () => {
  it("repairs a lost renewal before the sweep would lapse it, and confirms the paid period", async () => {
    const h = await createHarness();
    await subscribed(h, "org_a", later(DAY));
    const start = unix(later(DAY));
    h.stripe.subscriptions.set(
      "sub_org_a",
      subscriptionJson({
        id: "sub_org_a",
        customer: "cus_org_a",
        periodStart: start,
        periodEnd: start + 30 * 86_400,
        latestInvoice: "in_2",
      }),
    );
    h.stripe.invoices.set(
      "in_2",
      invoiceJson({
        id: "in_2",
        subscription: "sub_org_a",
        lines: [{ amount: 4900, start, end: start + 30 * 86_400 }],
      }),
    );
    // Past the old period's end plus the 48 h leeway: only the repair keeps access.
    const pastLeeway = 3 * DAY + 1;
    h.advance(pastLeeway);
    const report = await run(h.billing.reconcile({ limit: 10 }));
    await run(h.billing.sweepAccess({ limit: 10 }));
    const [sub] = (await run(h.billing.status("org_a"))).subscriptions;
    expect([
      report.refreshed,
      sub!.currentPeriodPaid,
      h.decisions.at(-1)!.features.workspace.allowed,
    ]).toEqual([1, true, true]);

    // The same moment with no repair: the sweep alone lapses the customer.
    const control = await createHarness();
    await subscribed(control, "org_a", later(DAY));
    control.advance(pastLeeway);
    await run(control.billing.sweepAccess({ limit: 10 }));
    expect(control.decisions.at(-1)!.features.workspace.allowed).toBe(false);
  });

  /** An active renewal 3 h old with no invoice.paid yet; Stripe's latest invoice has `status`. */
  async function renewalAwaitingInvoice(h: Harness, status: string) {
    const start = unix(later(-3 * HOUR));
    await subscribed(h, "org_a", later(30 * DAY - 3 * HOUR));
    h.stripe.subscriptions.set(
      "sub_org_a",
      subscriptionJson({
        id: "sub_org_a",
        customer: "cus_org_a",
        periodStart: start,
        periodEnd: start + 30 * 86_400,
        latestInvoice: "in_1",
      }),
    );
    await run(
      h.storage.upsertSubscription(
        subscriptionWrite({
          providerSubscriptionId: "sub_org_a",
          customerRef: "org_a",
          currentPeriodStart: new Date(start * 1000),
          currentPeriodEnd: new Date((start + 30 * 86_400) * 1000),
          fetchStartedAt: later(1),
        }),
        h.now(),
      ),
    );
    h.stripe.invoices.set(
      "in_1",
      invoiceJson({
        id: "in_1",
        subscription: "sub_org_a",
        status,
        lines: [{ amount: 4900, start, end: start + 30 * 86_400 }],
      }),
    );
    await run(h.billing.reconcile({ limit: 10 }));
    return (await run(h.billing.status("org_a"))).subscriptions[0]!;
  }

  it("stores a subscription whose price no plan names any more on no plan, never the old one", async () => {
    const h = await createHarness();
    const end = later(-HOUR);
    await subscribed(h, "org_a", end);
    h.stripe.subscriptions.set(
      "sub_org_a",
      subscriptionJson({
        id: "sub_org_a",
        customer: "cus_org_a",
        planId: null,
        product: "prod_unmapped",
        priceId: "price_unmapped",
        periodStart: unix(end),
        periodEnd: unix(end) + 30 * 86_400,
      }),
    );
    expect(await run(h.billing.reconcile({ limit: 10 }))).toMatchObject({ refreshed: 1 });
    expect((await run(h.storage.findSubscription("sub_org_a")))!.planId).toBeNull();
    expect((await run(h.billing.check("org_a", "workspace"))).allowed).toBe(false);
  });

  it("also confirms an active period whose invoice.paid never arrived", async () => {
    const h = await createHarness();
    expect((await renewalAwaitingInvoice(h, "paid")).currentPeriodPaid).toBe(true);
  });

  it("confirms no period from a latest invoice that is not paid", async () => {
    const h = await createHarness();
    const sub = await renewalAwaitingInvoice(h, "open");
    expect(h.stripe.callsTo("GET", "/v1/invoices/in_1")).toHaveLength(1);
    expect([sub.currentPeriodPaid, sub.paidPeriod]).toEqual([false, null]);
  });

  it("skips ended subscriptions, marks a vanished one canceled, and does not let a failing row block the others", async () => {
    const h = await createHarness();
    for (const ref of ["org_a", "org_b"]) await subscribed(h, ref, later(DAY));
    await subscribed(h, "org_c", later(DAY));
    await run(
      h.storage.upsertSubscription(
        subscriptionWrite({
          providerSubscriptionId: "sub_org_c",
          customerRef: "org_c",
          status: "canceled",
          currentPeriodEnd: later(DAY),
          fetchStartedAt: later(1),
        }),
        h.now(),
      ),
    );
    h.stripe.setIntercept((call) =>
      call.path === "/v1/subscriptions/sub_org_a"
        ? new Response("down", { status: 503 })
        : undefined,
    );
    h.advance(2 * DAY);
    const first = await run(h.billing.reconcile({ limit: 1 }));
    const second = await run(h.billing.reconcile({ limit: 1 }));
    expect([
      first.selected + second.selected,
      first.failed + second.failed,
      first.missing + second.missing,
    ]).toEqual([2, 1, 1]);
    expect((await run(h.storage.findSubscription("sub_org_b")))!.status).toBe("canceled");
    expect(h.stripe.callsTo("GET", "/v1/subscriptions/sub_org_c")).toHaveLength(0);
  });
});

describe("sweepAccess counts", () => {
  it("skips a customer whose lease is held, and visits it once the lease runs out", async () => {
    const h = await createHarness();
    await subscribed(h, "org_a", later(DAY));
    h.advance(4 * DAY);
    const until = new Date(h.now().getTime() + 60_000);
    await run(h.storage.acquireAccess({ customerRef: "org_a", now: h.now(), until }));
    expect(await run(h.billing.sweepAccess({ limit: 10 }))).toEqual({
      visited: 0,
      applied: 0,
      busy: 0,
      failed: 0,
    });
    h.advance(60_000);
    expect(await run(h.billing.sweepAccess({ limit: 10 }))).toMatchObject({ applied: 1 });
  });

  it("counts a lease taken between the listing and the apply as busy, without waiting on it", async () => {
    const calls = new Map<string, number>();
    const h = await createHarness({
      wrap: (inner) => {
        // Another process takes each listed customer's lease as the list returns.
        const racingList: BillingStorage["listDueCustomers"] = (now, limit) =>
          inner.listDueCustomers(now, limit).pipe(
            Effect.tap((refs) =>
              Effect.forEach(refs, (customerRef) =>
                inner.acquireAccess({
                  customerRef,
                  now,
                  until: new Date(now.getTime() + 60_000),
                }),
              ),
            ),
          );
        return new Proxy(counting(calls)(inner), {
          get: (target, key, receiver) =>
            key === "listDueCustomers" ? racingList : Reflect.get(target, key, receiver),
        });
      },
    });
    await subscribed(h, "org_a", later(DAY));
    h.advance(4 * DAY);
    calls.clear();
    const report = await run(h.billing.sweepAccess({ limit: 10 }));
    expect(report).toEqual({ visited: 1, applied: 0, busy: 1, failed: 0 });
    expect([calls.get("acquireAccess"), calls.get("findCustomer") ?? 0]).toEqual([1, 0]);
  });

  it("keeps a failing customer due at once when a write landed while its hook ran", async () => {
    const h = await createHarness({
      hooks: {
        onAccess: () =>
          // A grant lands mid-attempt, then the hook fails.
          h.storage
            .upsertGrant(
              {
                customerRef: "org_a",
                featureId: "workspace",
                source: "comp",
                grantedBy: "ops",
                expiresAt: null,
              },
              h.now(),
            )
            .pipe(Effect.andThen(Effect.fail("broken listing"))),
      },
    });
    await subscribed(h, "org_a", later(DAY));
    h.advance(5 * DAY);
    expect(await run(h.billing.sweepAccess({ limit: 1 }))).toMatchObject({ failed: 1 });
    expect(await run(h.storage.listDueCustomers(h.now(), 10))).toEqual(["org_a"]);
  });

  it("puts a customer whose hook fails behind the customers not yet tried", async () => {
    const h = await createHarness({
      hooks: {
        onAccess: (decision) =>
          decision.customerRef === "org_a" ? Effect.fail("broken listing") : Effect.void,
      },
    });
    await subscribed(h, "org_a", later(DAY));
    await subscribed(h, "org_b", later(2 * DAY));
    h.advance(5 * DAY);
    expect(await run(h.billing.sweepAccess({ limit: 1 }))).toMatchObject({ failed: 1 });
    expect(await run(h.billing.sweepAccess({ limit: 1 }))).toMatchObject({ applied: 1 });
    // org_a comes due again after the retry interval.
    expect(await run(h.storage.listDueCustomers(h.now(), 10))).toEqual([]);
    h.advance(15 * 60_000);
    expect(await run(h.storage.listDueCustomers(h.now(), 10))).toEqual(["org_a"]);
  });
});

describe("reapplyAll", () => {
  it("returns the refs whose hook failed", async () => {
    const h = await createHarness({ hooks: { onAccess: () => Effect.fail("table locked") } });
    const report = await run(h.billing.reapplyAll({ customerRefs: ["org_x", "org_y"] }));
    expect(report).toEqual({ applied: 0, failed: ["org_x", "org_y"] });
  });

  it("applies the current decision, under the lease, to refs that have no billing row", async () => {
    const h = await createHarness();
    const report = await run(h.billing.reapplyAll({ customerRefs: ["org_never_paid"] }));
    expect([
      report.applied,
      h.decisions[0]!.customerRef,
      h.decisions[0]!.features.workspace.allowed,
    ]).toEqual([1, "org_never_paid", false]);
    expect((await run(h.storage.findCustomer("org_never_paid")))!.accessLockUntil).toBeNull();
  });
});
