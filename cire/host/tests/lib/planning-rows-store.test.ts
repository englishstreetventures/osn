import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanningRows } from "../../src/lib/locked-exports";
import {
  __resetPlanningRowsStore,
  ensurePlanningRowsLoaded,
  planningRowsAccessor,
} from "../../src/lib/planning-rows-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";

const ROWS: PlanningRows = { budgetLines: 3, tasks: 0 };

beforeEach(() => {
  __resetWeddingScope();
  __resetPlanningRowsStore();
});

/**
 * The counts behind the locked Budget and Checklist cards. Each card mounts on
 * every open, on the rail and in the sheet, and every request spends the
 * owner's per-user export allowance, so the wedding is asked once. Dropping a
 * wedding is covered with every other store in `wedding-caches.test.ts`.
 */
describe("planning-rows-store", () => {
  it("is empty until the counts load", () => {
    expect(planningRowsAccessor("wed_a")()).toBeNull();
  });

  it("asks once and answers every later caller from the cache", async () => {
    const fetcher = vi.fn(async () => ROWS);
    expect(await ensurePlanningRowsLoaded("wed_a", fetcher)).toBe(true);
    expect(await ensurePlanningRowsLoaded("wed_a", fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(planningRowsAccessor("wed_a")()).toEqual(ROWS);
  });

  it("shares one request between callers that ask at the same time", async () => {
    let settle: (rows: PlanningRows) => void = () => {};
    const fetcher = vi.fn(() => new Promise<PlanningRows>((resolve) => (settle = resolve)));
    const first = ensurePlanningRowsLoaded("wed_a", fetcher);
    const second = ensurePlanningRowsLoaded("wed_a", fetcher);
    settle(ROWS);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches nothing when the request fails, so the next caller asks again", async () => {
    const failing = vi.fn(async (): Promise<PlanningRows> => {
      throw new Error("http_429");
    });
    await expect(ensurePlanningRowsLoaded("wed_a", failing)).rejects.toThrow("http_429");
    expect(planningRowsAccessor("wed_a")()).toBeNull();

    const working = vi.fn(async () => ROWS);
    expect(await ensurePlanningRowsLoaded("wed_a", working)).toBe(true);
    expect(working).toHaveBeenCalledTimes(1);
    expect(planningRowsAccessor("wed_a")()).toEqual(ROWS);
  });

  it("keeps each wedding's counts apart", async () => {
    await ensurePlanningRowsLoaded("wed_a", async () => ROWS);
    expect(planningRowsAccessor("wed_b")()).toBeNull();
  });
});
