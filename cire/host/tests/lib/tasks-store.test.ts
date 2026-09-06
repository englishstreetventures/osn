import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTasksCache,
  ensureTasksLoaded,
  hasCachedTasks,
  invalidateTasks,
  openTaskCount,
  peekCachedTasks,
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
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted Checklist view captures that accessor at mount. Deleting
   * the map entry on invalidate would leave that accessor pointed at a
   * signal nothing writes to again — a dead view showing stale tasks
   * forever. The fix writes THROUGH the signal, so an accessor captured
   * before invalidate still observes the transition.
   */
  it("a mounted consumer's captured accessor observes null after invalidate", async () => {
    await ensureTasksLoaded("wed_1", async () => [row({})]);
    const mounted = tasksAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateTasks("wed_1");
    expect(mounted()).toBeNull();
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
    expect(hasCachedTasks("wed_1")).toBe(true);
  });
});
