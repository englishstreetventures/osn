import { createEffect, createRoot } from "solid-js";
import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTasksCache,
  ensureTasksLoaded,
  hasCachedTasks,
  invalidateTasks,
  openTaskCount,
  peekCachedTasks,
  setCachedTasks,
  taskCounts,
  type TaskRow,
  tasksAccessor,
} from "../../src/lib/tasks-store";

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "T",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

beforeEach(() => __resetTasksCache());

describe("tasks-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [row({})];
    };
    await ensureTasksLoaded("wed_1", fetcher);
    await ensureTasksLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(tasksAccessor("wed_1")()?.length).toBe(1);
  });

  it("openTaskCount counts only open tasks, null before load", async () => {
    expect(openTaskCount("wed_1")).toBeNull();
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    expect(openTaskCount("wed_1")).toBe(2);
  });

  it("taskCounts returns open/done/total, null before load", async () => {
    expect(taskCounts("wed_none")).toBeNull();
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    expect(taskCounts("wed_1")).toEqual({ open: 2, done: 1, total: 3 });
  });

  /**
   * The regression test for the actual bug (#620): `openTaskCount` used to
   * read `cache.get(weddingId)?.tasks()`, so from a COLD cache the optional
   * chain short-circuited before the accessor was ever called — a tracking
   * computation that only reads `openTaskCount` registered zero dependencies
   * and never re-ran once the load resolved. `expect(openTaskCount(...)).toBe(2)`
   * after an await (the test above) can't see that: it re-reads the map
   * directly on every call, so it passes against the broken code too. Only a
   * live tracking computation, asserted on the values it actually observed,
   * proves the subscription fired.
   */
  it("a tracking computation reading only openTaskCount re-runs once the cold load resolves", async () => {
    const seen: (number | null)[] = [];
    const dispose = createRoot((d) => {
      createEffect(() => {
        seen.push(openTaskCount("wed_1"));
      });
      return d;
    });
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    // Let any effect queued by the cache write flush before asserting.
    await Promise.resolve();
    await Promise.resolve();
    dispose();
    expect(seen).toEqual([null, 2]);
  });

  /**
   * Same regression, for `taskCounts`. It returns a fresh object on every
   * run, so the observed values are asserted structurally, never by identity.
   */
  it("a tracking computation reading only taskCounts re-runs once the cold load resolves", async () => {
    const seen: ({ open: number; done: number; total: number } | null)[] = [];
    const dispose = createRoot((d) => {
      createEffect(() => {
        seen.push(taskCounts("wed_1"));
      });
      return d;
    });
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    // Let any effect queued by the cache write flush before asserting.
    await Promise.resolve();
    await Promise.resolve();
    dispose();
    expect(seen).toEqual([null, { open: 2, done: 1, total: 3 }]);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted Checklist view captures that accessor at mount. Deleting
   * the map entry on invalidate would leave that accessor pointed at a
   * signal nothing writes to again — a dead view showing stale tasks
   * forever. The fix writes THROUGH the signal, so an accessor captured
   * before invalidate still observes the transition.
   */
  it("a mounted consumer's captured accessor keeps the previous tasks after invalidate", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({})]);
    const mounted = tasksAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateTasks("wed_1");
    expect(mounted()).not.toBeNull();
    expect(hasCachedTasks("wed_1")).toBe(false);
  });

  it("ensureTasksLoaded resolves true after a normal load, and true again on a cache hit without refetching", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [row({})];
    };
    await expect(ensureTasksLoaded("wed_1", fetcher)).resolves.toBe(true);
    await expect(ensureTasksLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("hasCachedTasks is false after invalidate, so the next load refetches", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({})]);
    expect(hasCachedTasks("wed_1")).toBe(true);
    invalidateTasks("wed_1");
    expect(hasCachedTasks("wed_1")).toBe(false);
    let calls = 0;
    await ensureTasksLoaded("wed_1", async () => {
      calls += 1;
      return [row({})];
    });
    expect(calls).toBe(1);
  });

  /**
   * A fetch already in flight when the invalidate runs was issued against
   * PRE-mutation state. Clearing the signal alone would not stop its `.then`
   * writing those stale rows in afterwards — the generation bump does.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (rows: TaskRow[]) => void;
    const stale = new Promise<TaskRow[]>((r) => {
      resolveStale = r;
    });
    const pending = ensureTasksLoaded("wed_1", () => stale);

    invalidateTasks("wed_1");
    resolveStale([row({ id: "stale" })]);
    await pending;

    const fresh = async () => [row({ id: "fresh" })];
    await ensureTasksLoaded("wed_1", fresh);

    expect(tasksAccessor("wed_1")()?.map((t) => t.id)).toEqual(["fresh"]);
    expect(hasCachedTasks("wed_1")).toBe(true);
  });

  it("peekCachedTasks reflects fresh rows after an invalidate/reload cycle", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({ id: "a" })]);
    invalidateTasks("wed_1");
    await ensureTasksLoaded("wed_1", async () => [row({ id: "b" })]);
    expect(peekCachedTasks("wed_1")?.map((t) => t.id)).toEqual(["b"]);
  });

  /**
   * The `.finally` that clears the in-flight slot is reached on a rejection
   * too — a rejected fetcher never runs the `.then`, so this is the only path
   * that exercises the guarded clear on a failed load. If the slot were left
   * populated, every later `ensureTasksLoaded` would await a dead promise
   * forever instead of refetching.
   */
  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const [a, b] = await Promise.allSettled([
      ensureTasksLoaded("wed_1", failing),
      ensureTasksLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1); // deduped even in failure
    expect(hasCachedTasks("wed_1")).toBe(false); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    let recoveringCalls = 0;
    await ensureTasksLoaded("wed_1", async () => {
      recoveringCalls += 1;
      return [row({})];
    });
    expect(recoveringCalls).toBe(1);
  });

  it("ensureTasksLoaded refetches after invalidate and replaces the stale rows on success", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({ id: "a" })]);
    invalidateTasks("wed_1");
    await ensureTasksLoaded("wed_1", async () => [row({ id: "b" })]);
    expect(tasksAccessor("wed_1")()?.map((t) => t.id)).toEqual(["b"]);
    expect(hasCachedTasks("wed_1")).toBe(true);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known checklist behind an error banner just because the
   * stale-while-revalidate contract kept the old tasks on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureTasksLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({})]);
    invalidateTasks("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureTasksLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(tasksAccessor("wed_1")()).toBeNull();
  });

  it("__resetTasksCache clears the stale flag along with the cache", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({ id: "a" })]);
    invalidateTasks("wed_1"); // marks wed_1 stale
    __resetTasksCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedTasks` (not `ensureTasksLoaded`) look like a stale hit
    // forever, since only `ensureTasksLoaded`'s success path clears it.
    setCachedTasks("wed_1", [row({ id: "b" })]);
    expect(hasCachedTasks("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its checklist rows nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureTasksLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({ id: "seed" })]);
    invalidateTasks("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureTasksLoaded("wed_1", async () => {
      await gate;
      return [row({ id: "abandoned" })];
    });

    invalidateTasks("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await expect(pending).resolves.toBe(false);

    expect(tasksAccessor("wed_1")()?.map((t) => t.id)).toEqual(["seed"]);
    expect(hasCachedTasks("wed_1")).toBe(false);
  });
});
