import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetBudgetCache,
  type BudgetItemRow,
  type BudgetSnapshot,
  budgetAccessor,
  ensureBudgetLoaded,
  hasCachedBudget,
  invalidateBudget,
  type PaymentRow,
  peekCachedBudget,
  spentSoFar,
  upcomingPayments,
} from "../../src/lib/budget-store";

const item = (over: Partial<BudgetItemRow>): BudgetItemRow => ({
  id: "bit_1",
  weddingId: "wed_1",
  category: "venue",
  name: "Venue",
  estimateMinor: null,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const payment = (over: Partial<PaymentRow>): PaymentRow => ({
  id: "pay_1",
  budgetItemId: "bit_1",
  label: "Deposit",
  amountMinor: 1000,
  dueAt: null,
  paidAt: null,
  createdAt: 1,
  ...over,
});

const snap = (over: Partial<BudgetSnapshot>): BudgetSnapshot => ({
  items: [],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  ...over,
});

beforeEach(() => __resetBudgetCache());

describe("budget-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snap({ items: [item({})] });
    };
    await ensureBudgetLoaded("wed_1", fetcher);
    await ensureBudgetLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(budgetAccessor("wed_1")()?.items.length).toBe(1);
  });

  it("spentSoFar uses actual ?? quoted ?? estimate, null before load", async () => {
    expect(spentSoFar("wed_1")).toBeNull();
    await ensureBudgetLoaded("wed_1", async () =>
      snap({
        items: [
          item({ id: "a", estimateMinor: 1000, quotedMinor: 1200, actualMinor: 1250 }),
          item({ id: "b", estimateMinor: 1800 }),
        ],
      }),
    );
    expect(spentSoFar("wed_1")).toBe(1250 + 1800);
  });

  it("upcomingPayments returns only unpaid, earliest due first", async () => {
    await ensureBudgetLoaded("wed_1", async () =>
      snap({
        payments: [
          payment({ id: "p1", dueAt: "2026-08-15", paidAt: null }),
          payment({ id: "p2", dueAt: "2026-03-01", paidAt: null }),
          payment({ id: "p3", dueAt: "2026-01-01", paidAt: 5 }), // paid → excluded
        ],
      }),
    );
    expect(upcomingPayments("wed_1").map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted Budget view captures that accessor at mount. Deleting the
   * map entry on invalidate would leave that accessor pointed at a signal
   * nothing writes to again — a dead view showing stale figures forever. The
   * fix writes THROUGH the signal, so an accessor captured before invalidate
   * still observes the transition.
   */
  it("a mounted consumer's captured accessor observes null after invalidate", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({})] }));
    const mounted = budgetAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateBudget("wed_1");
    expect(mounted()).toBeNull();
  });

  it("hasCachedBudget is false after invalidate, so the next load refetches", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({}));
    expect(hasCachedBudget("wed_1")).toBe(true);
    invalidateBudget("wed_1");
    expect(hasCachedBudget("wed_1")).toBe(false);
    let calls = 0;
    await ensureBudgetLoaded("wed_1", async () => {
      calls += 1;
      return snap({});
    });
    expect(calls).toBe(1);
  });

  /**
   * A fetch already in flight when the invalidate runs was issued against
   * PRE-mutation state. Clearing the signal alone would not stop its `.then`
   * writing that stale snapshot in afterwards — the generation bump does.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (s: BudgetSnapshot) => void;
    const stale = new Promise<BudgetSnapshot>((r) => {
      resolveStale = r;
    });
    const pending = ensureBudgetLoaded("wed_1", () => stale);

    invalidateBudget("wed_1");
    resolveStale(snap({ items: [item({ id: "stale" })] }));
    await pending;

    const fresh = async () => snap({ items: [item({ id: "fresh" })] });
    await ensureBudgetLoaded("wed_1", fresh);

    expect(budgetAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["fresh"]);
  });

  it("peekCachedBudget reflects fresh data after an invalidate/reload cycle", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "a" })] }));
    invalidateBudget("wed_1");
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "b" })] }));
    expect(peekCachedBudget("wed_1")?.items.map((i) => i.id)).toEqual(["b"]);
  });
});
