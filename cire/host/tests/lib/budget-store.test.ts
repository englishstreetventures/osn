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
  setCachedBudget,
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
   * still observes it.
   *
   * What changed since: invalidate used to null that signal outright, which
   * flashed the Budget view empty on every organiser edit while the
   * background refetch ran. It now leaves the snapshot in place and marks the
   * wedding `stale` instead — a mounted view keeps rendering the last-known
   * figures across the invalidate.
   */
  it("a mounted consumer's captured accessor keeps the previous snapshot after invalidate", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({})] }));
    const mounted = budgetAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateBudget("wed_1");
    expect(mounted()).not.toBeNull();
    expect(hasCachedBudget("wed_1")).toBe(false);
  });

  it("ensureBudgetLoaded resolves true after a normal load, and true again on a cache hit without refetching", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snap({ items: [item({})] });
    };
    await expect(ensureBudgetLoaded("wed_1", fetcher)).resolves.toBe(true);
    await expect(ensureBudgetLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(calls).toBe(1);
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
   * PRE-mutation state. Leaving the signal alone would not stop its `.then`
   * writing that stale snapshot in afterwards — the generation bump does,
   * discarding the abandoned load's result outright rather than caching it.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (s: BudgetSnapshot) => void;
    const staleFetch = new Promise<BudgetSnapshot>((r) => {
      resolveStale = r;
    });
    const pending = ensureBudgetLoaded("wed_1", () => staleFetch);

    invalidateBudget("wed_1");
    resolveStale(snap({ items: [item({ id: "stale" })] }));
    await pending;

    const fresh = async () => snap({ items: [item({ id: "fresh" })] });
    await ensureBudgetLoaded("wed_1", fresh);

    expect(budgetAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["fresh"]);
    // The abandoned load's `.then` returned early without touching `stale`, so
    // only the fresh, in-generation load clearing it counts.
    expect(hasCachedBudget("wed_1")).toBe(true);
  });

  it("peekCachedBudget reflects fresh data after an invalidate/reload cycle", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "a" })] }));
    invalidateBudget("wed_1");
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "b" })] }));
    expect(peekCachedBudget("wed_1")?.items.map((i) => i.id)).toEqual(["b"]);
  });

  /**
   * The `.finally` that clears the in-flight slot is reached on a rejection
   * too — a rejected fetcher never runs the `.then`, so this is the only path
   * that exercises the guarded clear on a failed load. If the slot were left
   * populated, every later `ensureBudgetLoaded` would await a dead promise
   * forever instead of refetching.
   */
  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const [a, b] = await Promise.allSettled([
      ensureBudgetLoaded("wed_1", failing),
      ensureBudgetLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1); // deduped even in failure
    expect(hasCachedBudget("wed_1")).toBe(false); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    let recoveringCalls = 0;
    await ensureBudgetLoaded("wed_1", async () => {
      recoveringCalls += 1;
      return snap({ items: [item({})] });
    });
    expect(recoveringCalls).toBe(1);
  });

  it("ensureBudgetLoaded refetches after invalidate and replaces the stale snapshot on success", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "a" })] }));
    invalidateBudget("wed_1");
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "b" })] }));
    expect(budgetAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["b"]);
    expect(hasCachedBudget("wed_1")).toBe(true);
  });

  /**
   * The ownership guard in `.finally` (`inflight.get(weddingId) === load`)
   * only matters when a second load has already taken the slot by the time
   * the first one settles: load A in flight, an invalidate, then load B takes
   * the slot before A resolves. Unguarded, A's `.finally` would delete B's
   * slot out from under it, and a caller arriving during B's flight would
   * fire a redundant third fetch instead of joining B.
   */
  it("a settling stale load does not clear a newer load's in-flight slot", async () => {
    let resolveA!: (s: BudgetSnapshot) => void;
    const aPromise = new Promise<BudgetSnapshot>((r) => {
      resolveA = r;
    });
    const loadA = ensureBudgetLoaded("wed_1", () => aPromise);

    invalidateBudget("wed_1");

    let resolveB!: (s: BudgetSnapshot) => void;
    const bPromise = new Promise<BudgetSnapshot>((r) => {
      resolveB = r;
    });
    const loadB = ensureBudgetLoaded("wed_1", () => bPromise);

    resolveA(snap({ items: [item({ id: "stale" })] }));
    await loadA;

    // B is still in flight. If A's `.finally` deleted B's slot, this third
    // caller would find no in-flight promise and fire its own fetch.
    let thirdCalls = 0;
    const thirdCaller = ensureBudgetLoaded("wed_1", async () => {
      thirdCalls += 1;
      return snap({ items: [item({ id: "third" })] });
    });
    expect(thirdCalls).toBe(0);

    resolveB(snap({ items: [item({ id: "fresh-b" })] }));
    await Promise.all([loadB, thirdCaller]);

    expect(budgetAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["fresh-b"]);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known budget behind an error banner just because the
   * stale-while-revalidate contract kept the old snapshot on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureBudgetLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "a" })] }));
    invalidateBudget("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureBudgetLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(budgetAccessor("wed_1")()).toBeNull();
  });

  it("__resetBudgetCache clears the stale flag along with the cache", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "a" })] }));
    invalidateBudget("wed_1"); // marks wed_1 stale
    __resetBudgetCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedBudget` (not `ensureBudgetLoaded`) look like a stale hit
    // forever, since only `ensureBudgetLoaded`'s success path clears it.
    setCachedBudget("wed_1", snap({ items: [item({ id: "b" })] }));
    expect(hasCachedBudget("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its budget figures nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureBudgetLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "seed" })] }));
    invalidateBudget("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureBudgetLoaded("wed_1", async () => {
      await gate;
      return snap({ items: [item({ id: "abandoned" })] });
    });

    invalidateBudget("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await expect(pending).resolves.toBe(false);

    expect(budgetAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["seed"]);
    expect(hasCachedBudget("wed_1")).toBe(false);
  });

  /**
   * Mirror of the generation-stale success test above, but for the failure
   * branch's own generation guard: a load abandoned by a newer invalidate
   * must not blank the entry on rejection either, because a newer load now
   * owns it. Without `if (generationOf(weddingId) === startedAt)` in the
   * `onErr` handler, this abandoned load's refusal would null out rows a
   * newer in-generation load (or a mounted view) still has a claim to — the
   * rejection must still propagate to the caller, but it must not touch the
   * signal.
   */
  it("a generation-stale rejection still propagates but does not blank an entry a newer load owns", async () => {
    await ensureBudgetLoaded("wed_1", async () => snap({ items: [item({ id: "seed" })] }));
    invalidateBudget("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const refusal = new Error("403");
    const pending = ensureBudgetLoaded("wed_1", async () => {
      await gate;
      throw refusal;
    });

    invalidateBudget("wed_1"); // a second invalidate, while that load is still in flight
    release();

    await expect(pending).rejects.toBe(refusal);
    expect(budgetAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["seed"]);
  });
});
