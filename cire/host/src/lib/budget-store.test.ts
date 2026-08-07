import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetBudgetCache,
  type BudgetItemRow,
  type BudgetSnapshot,
  budgetAccessor,
  ensureBudgetLoaded,
  type PaymentRow,
  spentSoFar,
  upcomingPayments,
} from "./budget-store";

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
});
