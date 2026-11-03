import { describe, expect, it } from "vitest";

import { subscriptionWrite } from "../storage/contract";
import { createHarness, DAY, HOUR, run, T0, unix } from "../support/billing";
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
    h.advance(2 * DAY);
    const report = await run(h.billing.reconcile({ limit: 10 }));
    await run(h.billing.sweepAccess({ limit: 10 }));
    const [sub] = (await run(h.billing.status("org_a"))).subscriptions;
    expect([
      report.refreshed,
      sub!.currentPeriodPaid,
      h.decisions.at(-1)!.features.workspace.allowed,
    ]).toEqual([1, true, true]);
  });

  it("also confirms an active period whose invoice.paid never arrived", async () => {
    const h = await createHarness();
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
        lines: [{ amount: 4900, start, end: start + 30 * 86_400 }],
      }),
    );
    await run(h.billing.reconcile({ limit: 10 }));
    expect((await run(h.billing.status("org_a"))).subscriptions[0]!.currentPeriodPaid).toBe(true);
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

describe("reapplyAll", () => {
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
