import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { subscriptionWrite } from "../storage/contract";
import { createHarness, DAY, flip, run, T0 } from "../support/billing";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const later = (ms: number) => new Date(T0.getTime() + ms);
const activeUntil = (h: Harness, end: Date, fetched = h.now()) =>
  run(
    h.storage.upsertSubscription(
      subscriptionWrite({ currentPeriodEnd: end, fetchStartedAt: fetched }),
      h.now(),
    ),
  );

describe("applying access", () => {
  it("re-runs the hook when a write lands during it, so the last call is current", async () => {
    let calls = 0;
    const seen: boolean[] = [];
    const h: Harness = await createHarness({
      hooks: {
        onAccess: (decision) =>
          Effect.gen(function* () {
            seen.push(decision.features.workspace.allowed);
            if (calls++ === 0) {
              // The subscription is canceled while the first decision is applied.
              yield* h.storage.upsertSubscription(
                subscriptionWrite({ status: "canceled", fetchStartedAt: later(1) }),
                h.now(),
              );
            }
          }),
      },
    });
    await run(h.storage.ensureCustomer("org_1", h.now()));
    await activeUntil(h, later(10 * DAY));
    await run(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "reports",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    expect(seen).toEqual([true, false]);
  });

  it("gives up with AccessBusy when writes keep landing past the budget, leaving the row due", async () => {
    const h: Harness = await createHarness({
      hooks: {
        onAccess: () =>
          h.storage
            .upsertSubscription(
              subscriptionWrite({ fetchStartedAt: new Date(Date.now()) }),
              h.now(),
            )
            .pipe(Effect.orDie),
      },
      tuning: { accessBudgetMs: 30 },
    });
    await run(h.storage.ensureCustomer("org_1", h.now()));
    const error = await flip(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    expect(error._tag).toBe("AccessBusy");
    expect(
      (await run(h.storage.findCustomer("org_1")))!.nextAccessBoundaryAt!.getTime(),
    ).toBeLessThanOrEqual(h.now().getTime());
  });

  it("takes over the lease of a holder that died", async () => {
    const h = await createHarness();
    await run(h.storage.ensureCustomer("org_1", h.now()));
    await run(
      h.storage.acquireAccess({ customerRef: "org_1", now: h.now(), until: later(30_000) }),
    );
    h.advance(30_000);
    await run(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    expect(h.decisions.at(-1)!.features.workspace.reason).toBe("grant");
  });

  it("waits for a live lease, and fails busy, row due, when it is never freed", async () => {
    const h = await createHarness();
    await run(h.storage.ensureCustomer("org_1", h.now()));
    const lease = await run(
      h.storage.acquireAccess({ customerRef: "org_1", now: h.now(), until: later(30_000) }),
    );
    // The holder lets go a moment later; the waiter then applies itself.
    expect(lease).not.toBeNull();
    setTimeout(
      () =>
        void run(
          h.storage.releaseAccess({ customerRef: "org_1", token: later(30_000), dueAt: h.now() }),
        ),
      20,
    );
    await run(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    expect(h.decisions).toHaveLength(1);

    await run(
      h.storage.acquireAccess({ customerRef: "org_1", now: h.now(), until: later(30_000) }),
    );
    expect(
      (await flip(h.billing.revokeGrant({ customerRef: "org_1", featureId: "workspace" })))._tag,
    ).toBe("AccessBusy");
    expect(await run(h.storage.listDueCustomers(h.now(), 10))).toEqual(["org_1"]);
  });

  it("stops waiting once another holder's completed application covers its write", async () => {
    const h = await createHarness();
    await run(h.storage.ensureCustomer("org_1", h.now()));
    const held = (ms: number) => ({ customerRef: "org_1", now: h.now(), until: later(ms) });
    await run(h.storage.acquireAccess(held(30_000)));
    const granting = run(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    // Wait until the grant has written (version 1) and is polling the busy lease.
    for (let i = 0; i < 200; i += 1) {
      if ((await run(h.storage.findCustomer("org_1")))!.accessVersion >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The other holder lets go, applies version 1 itself, and the lease is busy again.
    await run(
      Effect.gen(function* () {
        yield* h.storage.releaseAccess({
          customerRef: "org_1",
          token: later(30_000),
          dueAt: h.now(),
        });
        const lease = yield* h.storage.acquireAccess(held(60_000));
        yield* h.storage.completeAccess({
          customerRef: "org_1",
          token: later(60_000),
          version: lease!.version,
          boundary: null,
        });
        yield* h.storage.acquireAccess(held(90_000));
      }),
    );
    await granting;
    expect(h.decisions).toHaveLength(0);
  });

  it("frees the lease and leaves the row due when the hook fails", async () => {
    const h = await createHarness({
      hooks: { onAccess: () => Effect.fail("listing table locked") },
    });
    await run(h.storage.ensureCustomer("org_1", h.now()));
    const error = await flip(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    const row = (await run(h.storage.findCustomer("org_1")))!;
    expect([error._tag, "reason" in error ? error.reason : null, row.accessLockUntil]).toEqual([
      "AccessHookError",
      "failed",
      null,
    ]);
    expect(await run(h.storage.listDueCustomers(h.now(), 10))).toEqual(["org_1"]);
  });

  it("keeps the lease until it expires when the hook outlives its timeout, and aborts the hook", async () => {
    let signal: AbortSignal | undefined;
    const h = await createHarness({
      hooks: {
        onAccess: (_decision, context) =>
          Effect.sync(() => (signal = context.signal)).pipe(Effect.andThen(Effect.never)),
      },
      tuning: { hookTimeoutMs: 10 },
    });
    await run(h.storage.ensureCustomer("org_1", h.now()));
    const error = await flip(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    const row = (await run(h.storage.findCustomer("org_1")))!;
    expect([error._tag, "reason" in error ? error.reason : null, signal?.aborted]).toEqual([
      "AccessHookError",
      "timeout",
      true,
    ]);
    expect(row.accessLockUntil).not.toBeNull();
    expect(await run(h.storage.listDueCustomers(h.now(), 10))).toEqual(["org_1"]);
  });
});

describe("grants", () => {
  it("creates the customer row, applies, and sets the boundary to the grant's expiry", async () => {
    const h = await createHarness();
    await run(
      h.billing.grant({
        customerRef: "org_new",
        featureId: "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: later(5 * DAY),
      }),
    );
    const row = (await run(h.storage.findCustomer("org_new")))!;
    expect([row.nextAccessBoundaryAt, h.decisions[0]!.features.workspace.allowed]).toEqual([
      later(5 * DAY),
      true,
    ]);
    expect(
      await run(h.billing.revokeGrant({ customerRef: "org_new", featureId: "workspace" })),
    ).toBe(true);
    expect([
      h.decisions.at(-1)!.features.workspace.allowed,
      (await run(h.storage.findCustomer("org_new")))!.nextAccessBoundaryAt,
    ]).toEqual([false, null]);
  });

  it("refuses a feature no plan declares", async () => {
    const h = await createHarness();
    const error = await flip(
      h.billing.grant({
        customerRef: "org_1",
        featureId: "nope" as "workspace",
        source: "comp",
        grantedBy: "ops",
        expiresAt: null,
      }),
    );
    expect(error._tag).toBe("UnknownFeature");
  });
});

describe("check and status", () => {
  it("answer from the database alone", async () => {
    const h = await createHarness();
    await run(h.storage.ensureCustomer("org_1", h.now()));
    await activeUntil(h, later(10 * DAY));
    expect(await run(h.billing.check("org_1", "workspace"))).toEqual({
      allowed: true,
      reason: "subscription",
      status: "active",
      until: later(12 * DAY),
    });
    expect((await run(h.billing.check("org_1", "reports"))).allowed).toBe(false);
    await run(h.billing.status("org_1"));
    expect(h.stripe.calls).toHaveLength(0);
  });
});
