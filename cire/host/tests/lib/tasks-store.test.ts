import { createEffect, createRoot } from "solid-js";
import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTasksCache,
  beginTaskWrite,
  dropTasks,
  ensureTasksLoaded,
  hasCachedTasks,
  invalidateTasks,
  markTasksStale,
  openTaskCount,
  peekCachedTasks,
  readTaskList,
  rereadTasks,
  setCachedTasks,
  setFreshTasks,
  taskCounts,
  type TaskRow,
  tasksAccessor,
  viewerHostIdOf,
} from "../../src/lib/tasks-store";
import { __resetWeddingScope, closeWeddingScope } from "../../src/lib/wedding-scope";

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
  assigneeHostIds: [],
  ...over,
});

beforeEach(() => {
  __resetTasksCache();
  __resetWeddingScope();
});

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

  // An apply answers with the whole list. A list read sent before it must not
  // land on top, and the answer must not cost a second read.
  it("setFreshTasks keeps a write's whole list over a read already in flight, and asks for no other", async () => {
    let resolveStale!: (rows: TaskRow[]) => void;
    const stale = new Promise<TaskRow[]>((r) => {
      resolveStale = r;
    });
    invalidateTasks("wed_1");
    const pending = ensureTasksLoaded("wed_1", () => stale);

    setFreshTasks("wed_1", [row({ id: "applied" })]);
    resolveStale([row({ id: "stale" })]);
    await pending;

    expect(tasksAccessor("wed_1")()?.map((t) => t.id)).toEqual(["applied"]);
    expect(hasCachedTasks("wed_1")).toBe(true);
    let fetched = false;
    await ensureTasksLoaded("wed_1", async () => {
      fetched = true;
      return [];
    });
    expect(fetched).toBe(false);
  });

  it("setFreshTasks writes nothing for a wedding the organiser has left", () => {
    setCachedTasks("wed_1", [row({ id: "before" })]);
    closeWeddingScope("wed_1");
    setFreshTasks("wed_1", [row({ id: "late answer" })]);
    expect(peekCachedTasks("wed_1")?.map((t) => t.id)).toEqual(["before"]);
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
    await expect(ensureTasksLoaded("wed_1", async () => [row({ id: "b" })])).resolves.toBe(true);
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

  describe("the portal's own writes", () => {
    /** A read held open until `release`, answering `rows`. */
    function heldRead(rows: TaskRow[]) {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      return {
        release,
        fetcher: async () => {
          await gate;
          return rows;
        },
      };
    }

    // A signal can ask for a re-read while the organiser's own tick is out. The
    // server answers it from before the tick commits, and taking that answer
    // would flip the tick back under them.
    it("drops a read that lands while a write is out, and leaves the wedding stale", async () => {
      setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
      const end = beginTaskWrite("wed_1");
      setCachedTasks("wed_1", [row({ id: "a", status: "done" })]);

      invalidateTasks("wed_1");
      let committed = false;
      const read = heldRead([row({ id: "a", status: "open" })]);
      const pending = ensureTasksLoaded("wed_1", () =>
        committed ? Promise.resolve([row({ id: "a", status: "done" })]) : read.fetcher(),
      );
      read.release();

      await expect(pending).resolves.toBe(false);
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");
      expect(hasCachedTasks("wed_1")).toBe(false);

      // Once the write is over, the dropped read goes again and sees it.
      committed = true;
      end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");
      expect(hasCachedTasks("wed_1")).toBe(true);
    });

    it("drops a read sent while a write was out that answers after it ends, and reads again", async () => {
      setCachedTasks("wed_1", [row({ id: "a", status: "done" })]);
      const end = beginTaskWrite("wed_1");
      invalidateTasks("wed_1");
      let committed = false;
      let reads = 0;
      const read = heldRead([row({ id: "a", status: "open" })]);
      const pending = ensureTasksLoaded("wed_1", async () => {
        reads += 1;
        // The first answer was read before the write committed.
        return committed ? [row({ id: "a", status: "done" }), row({ id: "b" })] : read.fetcher();
      });

      end();
      committed = true;
      read.release();

      await expect(pending).resolves.toBe(false);
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");
      // The read it dropped goes again, after the write.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reads).toBe(2);
      expect(peekCachedTasks("wed_1")?.map((t) => t.id)).toEqual(["a", "b"]);
      expect(hasCachedTasks("wed_1")).toBe(true);
    });

    it("loads a wedding dropped while a write was out as soon as it is opened again", async () => {
      const end = beginTaskWrite("wed_1");
      dropTasks("wed_1");
      await expect(ensureTasksLoaded("wed_1", async () => [row({ id: "b" })])).resolves.toBe(true);
      expect(peekCachedTasks("wed_1")?.map((t) => t.id)).toEqual(["b"]);
      // The write that was out ending later changes nothing.
      end();
      expect(hasCachedTasks("wed_1")).toBe(true);
    });

    it("takes a read sent after every write has ended", async () => {
      setCachedTasks("wed_1", [row({ id: "a", status: "done" })]);
      const first = beginTaskWrite("wed_1");
      const second = beginTaskWrite("wed_1");
      first();
      // Ending twice ends one write once: the other is still out.
      first();
      invalidateTasks("wed_1");
      await expect(ensureTasksLoaded("wed_1", async () => [row({ id: "x" })])).resolves.toBe(false);
      second();

      invalidateTasks("wed_1");
      await expect(ensureTasksLoaded("wed_1", async () => [row({ id: "b" })])).resolves.toBe(true);
      expect(peekCachedTasks("wed_1")?.map((t) => t.id)).toEqual(["b"]);
      expect(hasCachedTasks("wed_1")).toBe(true);
    });
  });

  describe("a signal's re-read", () => {
    /** A stand-in server: each read answers what `rows` holds when it is
     *  answered, and a held read waits for `release()`. */
    function server(initial: TaskRow[]) {
      let rows = initial;
      const gates: (() => void)[] = [];
      let holding = false;
      let reads = 0;
      return {
        set: (next: TaskRow[]) => {
          rows = next;
        },
        hold: () => {
          holding = true;
        },
        /** Answer the oldest held read; later ones answer at once. */
        release: () => {
          holding = false;
          for (const open of gates.splice(0)) open();
        },
        reads: () => reads,
        fetcher: async () => {
          reads += 1;
          if (holding) await new Promise<void>((open) => gates.push(open));
          return rows;
        },
      };
    }
    const ids = (weddingId = "wed_1") => peekCachedTasks(weddingId)?.map((t) => t.id);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("sends one more read, not one per signal, for a burst that arrives while a read is out", async () => {
      setCachedTasks("wed_1", [row({ id: "a" })]);
      const api = server([row({ id: "a" }), row({ id: "b" })]);
      api.hold();
      const first = rereadTasks("wed_1", api.fetcher);
      await settle();
      expect(api.reads()).toBe(1);

      // Four more signals while that read is out.
      api.set([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
      const later = [1, 2, 3, 4].map(() => rereadTasks("wed_1", api.fetcher));
      await settle();
      expect(api.reads()).toBe(1);

      api.release();
      await first;
      await Promise.all(later);
      expect(api.reads()).toBe(2);
      // The read sent after the burst is the one that shows.
      expect(ids()).toEqual(["a", "b", "c"]);
      expect(hasCachedTasks("wed_1")).toBe(true);
    });

    it("sends no read while one of the portal's own writes is out, and one once it ends", async () => {
      setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
      const end = beginTaskWrite("wed_1");
      setCachedTasks("wed_1", [row({ id: "a", status: "done" })]);
      // The write's own signal beats its answer.
      const api = server([row({ id: "a", status: "open" })]);
      const pending = rereadTasks("wed_1", api.fetcher);
      await settle();
      expect(api.reads()).toBe(0);
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");

      // The write commits, a co-host adds a task, and the write answers.
      api.set([row({ id: "a", status: "done" }), row({ id: "b" })]);
      end();
      await expect(pending).resolves.toBe(true);
      expect(api.reads()).toBe(1);
      expect(ids()).toEqual(["a", "b"]);
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");
    });

    it("sends a read the portal's own write made it drop again once the write ends", async () => {
      setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
      const api = server([row({ id: "a", status: "open" }), row({ id: "b" })]);
      api.hold();
      const pending = rereadTasks("wed_1", api.fetcher);
      await settle();
      const end = beginTaskWrite("wed_1");
      setCachedTasks("wed_1", [row({ id: "a", status: "done" })]);

      // Answered from before the tick committed: dropped, not shown.
      api.release();
      await settle();
      expect(peekCachedTasks("wed_1")?.map((t) => t.status)).toEqual(["done"]);
      expect(api.reads()).toBe(1);

      api.set([row({ id: "a", status: "done" }), row({ id: "b" })]);
      end();
      await pending;
      await settle();
      expect(api.reads()).toBe(2);
      expect(ids()).toEqual(["a", "b"]);
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");
    });

    it("drops a read sent before a write that answers after it ended, and reads again", async () => {
      setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
      const api = server([row({ id: "a", status: "open" })]);
      api.hold();
      const pending = rereadTasks("wed_1", api.fetcher);
      await settle();
      // The whole write starts and ends while that read is out.
      const end = beginTaskWrite("wed_1");
      setCachedTasks("wed_1", [row({ id: "a", status: "done" })]);
      end();
      api.set([row({ id: "a", status: "done" })]);
      api.release();
      await pending;
      await settle();
      expect(api.reads()).toBe(2);
      expect(peekCachedTasks("wed_1")?.[0]?.status).toBe("done");
      expect(hasCachedTasks("wed_1")).toBe(true);
    });

    it("blanks the rows when a read sent again after a write fails, and leaves nothing unhandled", async () => {
      setCachedTasks("wed_1", [row({ id: "a" })]);
      invalidateTasks("wed_1");
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = ensureTasksLoaded("wed_1", async () => {
        reads += 1;
        if (reads === 1) {
          await gate;
          return [row({ id: "a" })];
        }
        throw new Error("refused");
      });
      const end = beginTaskWrite("wed_1");
      release();
      await expect(pending).resolves.toBe(false);
      end();
      await settle();
      await settle();
      expect(reads).toBe(2);
      expect(peekCachedTasks("wed_1")).toBeNull();
    });

    it("waits for every write that is out, and then reads once", async () => {
      setCachedTasks("wed_1", [row({ id: "a" })]);
      const first = beginTaskWrite("wed_1");
      const second = beginTaskWrite("wed_1");
      const api = server([row({ id: "b" })]);
      const pending = rereadTasks("wed_1", api.fetcher);
      void rereadTasks("wed_1", api.fetcher);

      first();
      await settle();
      expect(api.reads()).toBe(0);
      second();
      await expect(pending).resolves.toBe(true);
      await settle();
      expect(api.reads()).toBe(1);
      expect(ids()).toEqual(["b"]);
    });

    it("marks the wedding stale without dropping the read in flight", async () => {
      setCachedTasks("wed_1", [row({ id: "a" })]);
      invalidateTasks("wed_1");
      const api = server([row({ id: "b" })]);
      api.hold();
      const pending = ensureTasksLoaded("wed_1", api.fetcher);

      // A tab that shows no tasks: the signal only marks the cache.
      markTasksStale("wed_1");
      api.release();
      await expect(pending).resolves.toBe(true);
      expect(api.reads()).toBe(1);
      // The rows that read brought are shown, but they may predate the
      // signal, so the next view to open reads again.
      expect(ids()).toEqual(["b"]);
      expect(hasCachedTasks("wed_1")).toBe(false);
      await ensureTasksLoaded("wed_1", api.fetcher);
      expect(api.reads()).toBe(2);
    });

    it("sends no queued read for a wedding forgotten while it waited", async () => {
      setCachedTasks("wed_1", [row({ id: "a" })]);
      const end = beginTaskWrite("wed_1");
      const api = server([row({ id: "b" })]);
      const pending = rereadTasks("wed_1", api.fetcher);

      dropTasks("wed_1");
      await expect(pending).resolves.toBe(false);
      end();
      await settle();
      expect(api.reads()).toBe(0);
    });

    it("sends no read for a wedding the organiser has left", async () => {
      closeWeddingScope("wed_1");
      const api = server([row({ id: "b" })]);
      await expect(rereadTasks("wed_1", api.fetcher)).resolves.toBe(false);
      expect(api.reads()).toBe(0);
    });

    it("hands the view that asked the error of a re-read that failed", async () => {
      setCachedTasks("wed_1", [row({ id: "a" })]);
      const end = beginTaskWrite("wed_1");
      const pending = rereadTasks("wed_1", async () => {
        throw new Error("refused");
      });
      end();
      await expect(pending).rejects.toThrow("refused");
    });
  });

  describe("the reader's own seat", () => {
    it("keeps the seat a task read names, for any view of the wedding, and hands back the rows", () => {
      const seen: (string | null)[] = [];
      const dispose = createRoot((d) => {
        createEffect(() => seen.push(viewerHostIdOf("wed_1")));
        return d;
      });
      const rows = readTaskList("wed_1", { tasks: [row({ id: "a" })], viewerHostId: "whost_me" });
      expect(rows.map((t) => t.id)).toEqual(["a"]);
      expect(seen).toEqual([null, "whost_me"]);
      dispose();
      expect(viewerHostIdOf("wed_2")).toBeNull();
    });

    it("reads an answer without the field as no seat", () => {
      readTaskList("wed_1", { tasks: [], viewerHostId: "whost_me" });
      readTaskList("wed_1", { tasks: [] });
      expect(viewerHostIdOf("wed_1")).toBeNull();
    });

    it("forgets the seat with the wedding", () => {
      readTaskList("wed_1", { tasks: [], viewerHostId: "whost_me" });
      dropTasks("wed_1");
      expect(viewerHostIdOf("wed_1")).toBeNull();
    });

    it("keeps no seat for a wedding the organiser has left", () => {
      closeWeddingScope("wed_1");
      const rows = readTaskList("wed_1", { tasks: [row({ id: "a" })], viewerHostId: "whost_me" });
      expect(rows.map((t) => t.id)).toEqual(["a"]);
      expect(viewerHostIdOf("wed_1")).toBeNull();
    });
  });
});
