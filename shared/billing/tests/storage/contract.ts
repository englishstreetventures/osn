/**
 * The `BillingStorage` contract, as a suite any adapter runs against itself:
 * bun:sqlite in `sqlite.test.ts`, Miniflare D1 in `../d1/storage.test.ts`.
 */

import { Effect } from "effect";

import type { BillingStorage, SubscriptionWrite } from "../../src/storage/port";

export interface ContractHarness {
  readonly storage: BillingStorage;
}

/**
 * The test runner's own functions. vitest runs the suite on bun:sqlite and
 * `bun test` runs it on Miniflare, which vitest cannot boot; both expose this
 * subset with the same meaning.
 */
interface Expectation {
  toBe(value: unknown): void;
  toEqual(value: unknown): void;
  toMatch(pattern: RegExp): void;
  toBeNull(): void;
  toHaveLength(length: number): void;
}
export interface Runner {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
  readonly expect: (actual: unknown) => Expectation;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const T0 = new Date("2030-06-01T00:00:00.000Z").getTime();
const at = (ms: number) => new Date(T0 + ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const subscriptionWrite = (over: Partial<SubscriptionWrite> = {}): SubscriptionWrite => ({
  providerSubscriptionId: "sub_1",
  customerRef: "org_1",
  planId: "monthly",
  providerPriceId: "price_1",
  interval: "month",
  status: "active",
  currency: "AUD",
  currentPeriodStart: at(0),
  currentPeriodEnd: at(30 * DAY),
  trialEnd: null,
  cancelAtPeriodEnd: false,
  fetchStartedAt: at(0),
  ...over,
});

export function storageContract(
  name: string,
  setup: () => Promise<ContractHarness>,
  { describe, it, expect }: Runner,
) {
  describe(`BillingStorage contract: ${name}`, () => {
    const fresh = async () => {
      const harness = await setup();
      await run(harness.storage.ensureCustomer("org_1", at(0)));
      return harness.storage;
    };

    it("ensureCustomer creates one row however often it is called", async () => {
      const storage = await fresh();
      const [a, b] = await Promise.all([
        run(storage.ensureCustomer("org_1", at(1))),
        run(storage.ensureCustomer("org_1", at(2))),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.id).toMatch(/^bcus_/);
      expect(a.accessVersion).toBe(0);
    });

    it("sets the provider customer id only while it is unset", async () => {
      const storage = await fresh();
      const customer = await run(storage.findCustomer("org_1"));
      expect(await run(storage.setProviderCustomerId(customer!.id, "cus_1"))).toBe(true);
      expect(await run(storage.setProviderCustomerId(customer!.id, "cus_2"))).toBe(false);
      expect((await run(storage.findCustomerByProviderId("cus_1")))?.customerRef).toBe("org_1");
      expect(await run(storage.findCustomerByProviderId("cus_2"))).toBeNull();
    });

    it("claims a checkout only against the nonce it read, and stores its session only under that nonce", async () => {
      const storage = await fresh();
      const { id } = (await run(storage.findCustomer("org_1")))!;
      const claim = (expectedNonce: string | null, nonce: string) =>
        run(
          storage.claimCheckout({
            customerId: id,
            expectedNonce,
            nonce,
            planId: "monthly",
            currency: "AUD",
            now: at(5),
          }),
        );
      expect(await claim(null, "n1")).toBe(true);
      expect(await claim(null, "n2")).toBe(false);
      expect(
        await run(storage.setCheckoutSession({ customerId: id, nonce: "n2", sessionId: "cs_x" })),
      ).toBe(false);
      expect(
        await run(storage.setCheckoutSession({ customerId: id, nonce: "n1", sessionId: "cs_1" })),
      ).toBe(true);
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout).toEqual({
        sessionId: "cs_1",
        planId: "monthly",
        currency: "AUD",
        nonce: "n1",
        startedAt: at(5),
      });
      expect(await claim("n1", "n3")).toBe(true);
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout?.sessionId).toBeNull();

      await run(storage.setCheckoutSession({ customerId: id, nonce: "n3", sessionId: "cs_3" }));
      await run(storage.clearCheckout({ customerId: id, sessionId: "cs_other" }));
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout?.sessionId).toBe("cs_3");
      await run(storage.clearCheckout({ customerId: id, sessionId: "cs_3" }));
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout).toBeNull();

      // A nonce that never got a session is abandoned only by its own holder.
      await claim(null, "n4");
      await run(storage.abandonCheckout({ customerId: id, nonce: "n9" }));
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout?.nonce).toBe("n4");
      await run(storage.abandonCheckout({ customerId: id, nonce: "n4" }));
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout).toBeNull();

      // Or puts back the checkout it replaced.
      await claim(null, "n5");
      const previous = {
        sessionId: "cs_paid",
        planId: "monthly",
        currency: "AUD",
        nonce: "n3",
        startedAt: at(5),
      };
      await run(storage.abandonCheckout({ customerId: id, nonce: "n5", restore: previous }));
      expect((await run(storage.findCustomer("org_1")))!.pendingCheckout).toEqual(previous);
    });

    it("never lets an older fetch overwrite a newer one, and lets an equal one through", async () => {
      const storage = await fresh();
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "active", fetchStartedAt: at(10) }),
          at(10),
        ),
      );
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "canceled", fetchStartedAt: at(9) }),
          at(11),
        ),
      );
      expect((await run(storage.findSubscription("sub_1")))!.status).toBe("active");
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "past_due", fetchStartedAt: at(10) }),
          at(12),
        ),
      );
      expect((await run(storage.findSubscription("sub_1")))!.status).toBe("past_due");
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "canceled", fetchStartedAt: at(20) }),
          at(20),
        ),
      );
      expect((await run(storage.findSubscription("sub_1")))!.status).toBe("canceled");
    });

    it("marks the customer dirty on every write access depends on, from a NULL boundary too", async () => {
      const storage = await fresh();
      const before = (await run(storage.findCustomer("org_1")))!;
      expect(before.nextAccessBoundaryAt).toBeNull();

      await run(storage.upsertSubscription(subscriptionWrite({ fetchStartedAt: at(1) }), at(100)));
      let customer = (await run(storage.findCustomer("org_1")))!;
      expect(customer.accessVersion > before.accessVersion).toBe(true);
      expect(customer.nextAccessBoundaryAt).toEqual(at(100));
      let last = customer.accessVersion;

      // An earlier boundary is kept: the row is already due.
      await run(
        storage.recordPaidPeriod({
          providerSubscriptionId: "sub_1",
          customerRef: "org_1",
          start: at(0),
          end: at(30 * DAY),
          now: at(200),
        }),
      );
      customer = (await run(storage.findCustomer("org_1")))!;
      expect(customer.accessVersion > last).toBe(true);
      expect(customer.nextAccessBoundaryAt).toEqual(at(100));
      last = customer.accessVersion;

      await run(
        storage.upsertGrant(
          {
            customerRef: "org_1",
            featureId: "workspace",
            source: "comp",
            grantedBy: "ops",
            expiresAt: null,
          },
          at(300),
        ),
      );
      customer = (await run(storage.findCustomer("org_1")))!;
      expect(customer.accessVersion > last).toBe(true);
      last = customer.accessVersion;
      await run(storage.deleteGrant("org_1", "workspace", at(400)));
      customer = (await run(storage.findCustomer("org_1")))!;
      expect(customer.accessVersion > last).toBe(true);

      // A later boundary is pulled in to now.
      const lease = await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(500), until: at(500 + HOUR) }),
      );
      expect(
        await run(
          storage.completeAccess({
            customerRef: "org_1",
            token: at(500 + HOUR),
            version: lease!.version,
            boundary: at(10 * DAY),
          }),
        ),
      ).toBe(true);
      await run(storage.upsertSubscription(subscriptionWrite({ fetchStartedAt: at(2) }), at(600)));
      expect((await run(storage.findCustomer("org_1")))!.nextAccessBoundaryAt).toEqual(at(600));
    });

    it("keeps past_due_since across refreshes and clears it once the subscription leaves past_due", async () => {
      const storage = await fresh();
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "past_due", fetchStartedAt: at(10) }),
          at(10),
        ),
      );
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "past_due", fetchStartedAt: at(20) }),
          at(20),
        ),
      );
      expect((await run(storage.findSubscription("sub_1")))!.pastDueSince).toEqual(at(10));
      await run(
        storage.upsertSubscription(
          subscriptionWrite({ status: "active", fetchStartedAt: at(30) }),
          at(30),
        ),
      );
      expect((await run(storage.findSubscription("sub_1")))!.pastDueSince).toBeNull();
    });

    it("only ever moves the paid period forward", async () => {
      const storage = await fresh();
      await run(storage.upsertSubscription(subscriptionWrite(), at(0)));
      const record = (start: number, end: number) =>
        run(
          storage.recordPaidPeriod({
            providerSubscriptionId: "sub_1",
            customerRef: "org_1",
            start: at(start),
            end: at(end),
            now: at(1),
          }),
        );
      await record(30 * DAY, 60 * DAY);
      await record(0, 30 * DAY);
      const sub = (await run(storage.findSubscription("sub_1")))!;
      expect([sub.paidPeriodStart, sub.paidPeriodEnd]).toEqual([at(30 * DAY), at(60 * DAY)]);
    });

    it("claims an event once, holds it under a lease, and lets an expired or released claim be retaken", async () => {
      const storage = await fresh();
      const claim = (now: number) =>
        run(
          storage.claimEvent({
            eventId: "evt_1",
            type: "invoice.paid",
            now: at(now),
            leaseUntil: at(now + 60_000),
          }),
        );
      expect(await claim(0)).toBe("claimed");
      expect(await claim(1_000)).toBe("held");
      expect(await claim(61_000)).toBe("claimed");
      await run(storage.releaseEvent("evt_1", at(121_000)));
      expect(await claim(62_000)).toBe("claimed");
      await run(storage.finishEvent("evt_1", "processed", at(122_000)));
      expect(await claim(500_000)).toBe("done");
    });

    it("lets only the current claim release or finish an event", async () => {
      const storage = await fresh();
      const claim = (now: number) =>
        run(
          storage.claimEvent({
            eventId: "evt_1",
            type: "invoice.paid",
            now: at(now),
            leaseUntil: at(now + 60_000),
          }),
        );
      expect(await claim(0)).toBe("claimed");
      // The first claim overran its lease and a redelivery took the event.
      expect(await claim(61_000)).toBe("claimed");
      await run(storage.releaseEvent("evt_1", at(60_000)));
      expect(await claim(62_000)).toBe("held");
      await run(storage.finishEvent("evt_1", "processed", at(60_000)));
      expect(await claim(63_000)).toBe("held");
      await run(storage.finishEvent("evt_1", "processed", at(121_000)));
      expect(await claim(500_000)).toBe("done");
    });

    it("replaces a grant, and deletes it", async () => {
      const storage = await fresh();
      const grant = {
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp" as const,
        grantedBy: "ops",
      };
      await run(storage.upsertGrant({ ...grant, expiresAt: at(DAY) }, at(0)));
      await run(storage.upsertGrant({ ...grant, expiresAt: null }, at(1)));
      expect(await run(storage.listGrants("org_1"))).toEqual([{ ...grant, expiresAt: null }]);
      expect(await run(storage.deleteGrant("org_1", "workspace", at(2)))).toBe(true);
      expect(await run(storage.deleteGrant("org_1", "workspace", at(3)))).toBe(false);
      expect(await run(storage.listGrants("org_1"))).toEqual([]);
    });

    it("hands the access lease to one holder at a time and refuses a stale completion", async () => {
      const storage = await fresh();
      const lease = await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(0), until: at(60_000) }),
      );
      // Each grant of the lease raises the version, so each holder's token is new.
      const first = lease!.version;
      expect(first > 0).toBe(true);
      expect(
        await run(storage.acquireAccess({ customerRef: "org_1", now: at(1), until: at(60_001) })),
      ).toBeNull();

      // A write lands under the lease: completion refuses, the row stays due.
      await run(storage.upsertSubscription(subscriptionWrite(), at(2)));
      expect(
        await run(
          storage.completeAccess({
            customerRef: "org_1",
            token: at(60_000),
            version: first,
            boundary: null,
          }),
        ),
      ).toBe(false);
      await run(
        storage.releaseAccess({
          customerRef: "org_1",
          token: at(60_000),
          dueAt: at(3),
          retry: null,
        }),
      );

      const second = (await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(4), until: at(60_004) }),
      ))!.version;
      expect(second > first).toBe(true);
      // The first holder's token no longer completes or releases anything.
      expect(
        await run(
          storage.completeAccess({
            customerRef: "org_1",
            token: at(60_000),
            version: second,
            boundary: null,
          }),
        ),
      ).toBe(false);
      expect(
        await run(
          storage.completeAccess({
            customerRef: "org_1",
            token: at(60_004),
            version: second,
            boundary: at(DAY),
          }),
        ),
      ).toBe(true);
      const done = (await run(storage.findCustomer("org_1")))!;
      expect([done.nextAccessBoundaryAt, done.accessAppliedVersion, done.accessLockUntil]).toEqual([
        at(DAY),
        second,
        null,
      ]);
    });

    it("lets a lease past its expiry be taken over", async () => {
      const storage = await fresh();
      const first = await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(0), until: at(60_000) }),
      );
      await run(storage.markAccessDue({ customerRef: "org_1", dueAt: at(10), retry: null }));
      expect((await run(storage.findCustomer("org_1")))!.nextAccessBoundaryAt).toEqual(at(10));
      const second = await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(60_000), until: at(120_000) }),
      );
      expect(second!.version > first!.version).toBe(true);
    });

    it("lists due customers earliest first, within the limit, never a NULL boundary or a held lease", async () => {
      const storage = await fresh();
      for (const [ref, due] of [
        ["org_a", 30],
        ["org_b", 10],
        ["org_c", 20],
        ["org_d", 99_999],
        ["org_e", 5],
      ] as const) {
        await run(storage.ensureCustomer(ref, at(0)));
        await run(storage.markAccessDue({ customerRef: ref, dueAt: at(due), retry: null }));
      }
      await run(storage.acquireAccess({ customerRef: "org_e", now: at(0), until: at(2_000) }));
      expect(await run(storage.listDueCustomers(at(1_000), 2))).toEqual(["org_b", "org_c"]);
      expect(await run(storage.listDueCustomers(at(1_000), 10))).toEqual([
        "org_b",
        "org_c",
        "org_a",
      ]);
      // A lease past its expiry no longer hides the row.
      expect(await run(storage.listDueCustomers(at(2_000), 1))).toEqual(["org_e"]);
    });

    it("moves a retried row's boundary to the retry time unless a write landed meanwhile; a plain release only ever earlier", async () => {
      const storage = await fresh();
      await run(storage.markAccessDue({ customerRef: "org_1", dueAt: at(10), retry: null }));
      await run(storage.markAccessDue({ customerRef: "org_1", dueAt: at(50), retry: null }));
      expect((await run(storage.findCustomer("org_1")))!.nextAccessBoundaryAt).toEqual(at(10));
      const release = async (now: number, landed: boolean) => {
        const lease = await run(
          storage.acquireAccess({ customerRef: "org_1", now: at(now), until: at(now + 60_000) }),
        );
        if (landed)
          await run(
            storage.upsertSubscription(subscriptionWrite({ fetchStartedAt: at(now) }), at(now)),
          );
        await run(
          storage.releaseAccess({
            customerRef: "org_1",
            token: at(now + 60_000),
            dueAt: at(now),
            retry: { until: at(HOUR), version: lease!.version },
          }),
        );
        return (await run(storage.findCustomer("org_1")))!.nextAccessBoundaryAt;
      };
      expect(await release(20, false)).toEqual(at(HOUR));
      // A write under the failed attempt keeps the row due now.
      expect(await release(30, true)).toEqual(at(30));
    });

    it("selects for reconcile: past period or unconfirmed recent period, never terminal, oldest attempt first", async () => {
      const storage = await fresh();
      const now = 100 * DAY;
      const write = (id: string, over: Partial<SubscriptionWrite>) =>
        run(
          storage.upsertSubscription(
            subscriptionWrite({ providerSubscriptionId: id, ...over }),
            at(0),
          ),
        );
      await write("sub_past", { currentPeriodEnd: at(now - DAY) });
      await write("sub_trial_past", {
        status: "trialing",
        currentPeriodEnd: at(now + DAY),
        trialEnd: at(now - DAY),
      });
      await write("sub_trial_future", {
        status: "trialing",
        currentPeriodEnd: at(now - DAY),
        trialEnd: at(now + DAY),
      });
      await write("sub_canceled", { status: "canceled", currentPeriodEnd: at(now - DAY) });
      await write("sub_current", {
        currentPeriodStart: at(now - 10 * DAY),
        currentPeriodEnd: at(now + 20 * DAY),
      });
      await write("sub_unconfirmed", {
        currentPeriodStart: at(now - 3 * HOUR),
        currentPeriodEnd: at(now + 30 * DAY),
      });
      // Younger than the 2 h lower bound: Stripe has not yet tried the charge.
      await write("sub_too_new", {
        currentPeriodStart: at(now - HOUR),
        currentPeriodEnd: at(now + 30 * DAY),
      });
      await write("sub_confirmed", {
        currentPeriodStart: at(now - 3 * HOUR),
        currentPeriodEnd: at(now + 30 * DAY),
      });
      await run(
        storage.recordPaidPeriod({
          providerSubscriptionId: "sub_confirmed",
          customerRef: "org_1",
          start: at(now - 3 * HOUR),
          end: at(now + 30 * DAY),
          now: at(1),
        }),
      );
      await write("sub_attempted", { currentPeriodEnd: at(now - DAY) });
      await run(storage.markReconciled("sub_attempted", at(now - 10 * 60_000)));
      await write("sub_old_attempt", { currentPeriodEnd: at(now - DAY) });
      await run(storage.markReconciled("sub_old_attempt", at(now - 2 * HOUR)));

      const selection = {
        now: at(now),
        attemptedBefore: at(now - HOUR),
        unconfirmedFrom: at(now - 7 * DAY),
        unconfirmedTo: at(now - 2 * HOUR),
      };
      const ids = (
        await run(storage.listSubscriptionsToReconcile({ ...selection, limit: 10 }))
      ).map((s) => s.providerSubscriptionId);
      expect(ids.toSorted()).toEqual([
        "sub_old_attempt",
        "sub_past",
        "sub_trial_past",
        "sub_unconfirmed",
      ]);
      // Never-attempted rows come before attempted ones.
      expect(ids.at(-1)).toBe("sub_old_attempt");
      expect(
        await run(storage.listSubscriptionsToReconcile({ ...selection, limit: 2 })),
      ).toHaveLength(2);
    });

    it("prunes every event received before the cutoff, finished or not", async () => {
      const storage = await fresh();
      await run(
        storage.claimEvent({ eventId: "evt_old_done", type: "x", now: at(0), leaseUntil: at(1) }),
      );
      await run(storage.finishEvent("evt_old_done", "processed", at(1)));
      await run(
        storage.claimEvent({ eventId: "evt_old_stuck", type: "x", now: at(0), leaseUntil: at(1) }),
      );
      await run(
        storage.claimEvent({
          eventId: "evt_new",
          type: "x",
          now: at(DAY),
          leaseUntil: at(DAY + 1),
        }),
      );
      expect(await run(storage.pruneEvents(at(HOUR)))).toBe(2);
      expect(
        await run(
          storage.claimEvent({
            eventId: "evt_new",
            type: "x",
            now: at(DAY),
            leaseUntil: at(DAY + 1),
          }),
        ),
      ).toBe("held");
    });

    it("refuses a subscription or a grant for a customer it has no row for", async () => {
      const storage = await fresh();
      const subscription = await Effect.runPromiseExit(
        storage.upsertSubscription(subscriptionWrite({ customerRef: "org_missing" }), at(0)),
      );
      const grant = await Effect.runPromiseExit(
        storage.upsertGrant(
          {
            customerRef: "org_missing",
            featureId: "workspace",
            source: "comp",
            grantedBy: "ops",
            expiresAt: null,
          },
          at(0),
        ),
      );
      expect([subscription._tag, grant._tag]).toEqual(["Failure", "Failure"]);
    });

    it("forgets a customer's grants, subscriptions and row, and no one else's, only under its lease", async () => {
      const storage = await fresh();
      const kept = await run(storage.ensureCustomer("org_2", at(0)));
      const gone = (await run(storage.findCustomer("org_1")))!;
      await run(storage.setProviderCustomerId(gone.id, "cus_1"));
      for (const ref of ["org_1", "org_2"]) {
        await run(
          storage.upsertSubscription(
            subscriptionWrite({ providerSubscriptionId: `sub_${ref}`, customerRef: ref }),
            at(1),
          ),
        );
        await run(
          storage.upsertGrant(
            {
              customerRef: ref,
              featureId: "workspace",
              source: "comp",
              grantedBy: "ops",
              expiresAt: null,
            },
            at(2),
          ),
        );
      }
      // A token that is not the lease's deletes nothing.
      expect(
        await run(storage.forgetCustomer({ customerRef: "org_1", token: at(60_000) })),
      ).toBeNull();
      expect((await run(storage.listGrants("org_1"))).length).toBe(1);
      expect((await run(storage.listSubscriptions("org_1"))).length).toBe(1);

      await run(storage.acquireAccess({ customerRef: "org_1", now: at(3), until: at(60_003) }));
      expect(
        await run(storage.forgetCustomer({ customerRef: "org_1", token: at(60_003) })),
      ).toEqual({ providerCustomerId: "cus_1" });
      expect([
        await run(storage.findCustomer("org_1")),
        await run(storage.findCustomerByProviderId("cus_1")),
        await run(storage.listSubscriptions("org_1")),
        await run(storage.listGrants("org_1")),
      ]).toEqual([null, null, [], []]);
      expect((await run(storage.findCustomer("org_2")))!.id).toBe(kept.id);
      expect((await run(storage.listSubscriptions("org_2"))).length).toBe(1);
      expect((await run(storage.listGrants("org_2"))).length).toBe(1);
    });

    it("starts a customer created again after erasure above every version the erased row gave", async () => {
      const storage = await fresh();
      for (let i = 0; i < 5; i += 1) {
        await run(storage.upsertSubscription(subscriptionWrite({ fetchStartedAt: at(i) }), at(i)));
      }
      const lease = await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(10), until: at(60_010) }),
      );
      await run(storage.forgetCustomer({ customerRef: "org_1", token: at(60_010) }));
      await run(storage.ensureCustomer("org_1", at(1_000)));
      const again = await run(
        storage.acquireAccess({ customerRef: "org_1", now: at(1_000), until: at(61_000) }),
      );
      expect(again!.version > lease!.version).toBe(true);
    });
  });
}
