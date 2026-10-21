import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRunSheetCache,
  dropRunSheet,
  ensureRunSheetLoaded,
  fetchRunSheet,
  invalidateRunSheet,
  markRunSheetStale,
  readRunSheet,
  rereadRunSheet,
  type RunSheet,
  RunSheetError,
  runSheetAccessor,
} from "../../src/lib/run-sheet-store";
import { scheduleChanged } from "../../src/lib/schedule-changed";
import {
  __resetTasksCache,
  beginTaskWrite,
  ensureTasksLoaded,
  hasCachedTasks,
} from "../../src/lib/tasks-store";
import { dropWeddingCaches } from "../../src/lib/wedding-caches";
import { __resetWeddingScope, closeWeddingScope } from "../../src/lib/wedding-scope";

/**
 * The run sheet's cache: a reread cache over `GET …/run-sheet` that shares the
 * checklist's write tracker, because a checklist write (a time set, a task
 * ticked or deleted) changes the run sheet too. A read the server may have
 * answered from before such a write must never land on top of it.
 */

const sheet = (taskIds: string[], over: Partial<RunSheet> = {}): RunSheet => ({
  scope: "full",
  viewerHostId: "whost_me",
  items: taskIds.map((id) => ({
    kind: "task" as const,
    id,
    title: id,
    notes: null,
    status: "open" as const,
    runAt: null,
    runTimezone: null,
    eventId: null,
    runOffsetMinutes: null,
    anchored: false,
    eventRemoved: false,
    assigneeHostIds: [],
  })),
  people: [],
  ...over,
});

const ids = (weddingId = "wed_1") => runSheetAccessor(weddingId)()?.items.map((i) => i.id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A stand-in server: each read answers what it holds when answered, and a
 *  held read waits for `release()`. */
function server(initial: RunSheet) {
  let value = initial;
  const gates: (() => void)[] = [];
  let holding = false;
  let reads = 0;
  return {
    set: (next: RunSheet) => {
      value = next;
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const open of gates.splice(0)) open();
    },
    reads: () => reads,
    fetcher: async () => {
      reads += 1;
      if (holding) await new Promise<void>((open) => gates.push(open));
      return value;
    },
  };
}

beforeEach(() => {
  __resetWeddingScope();
  __resetTasksCache();
  __resetRunSheetCache();
});

describe("run-sheet-store and the checklist's writes", () => {
  it("drops a run-sheet read that answers while a task write is out, and reads again once it ends", async () => {
    await ensureRunSheetLoaded("wed_1", async () => sheet(["a"]));
    const api = server(sheet(["a"]));
    api.hold();
    const pending = rereadRunSheet("wed_1", api.fetcher);
    await settle();
    const end = beginTaskWrite("wed_1");
    // Answered from before the write committed: dropped, not shown.
    api.release();
    await settle();
    expect(api.reads()).toBe(1);
    expect(ids()).toEqual(["a"]);

    api.set(sheet(["a", "b"]));
    end();
    await pending;
    await settle();
    expect(api.reads()).toBe(2);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("sends no re-read while a task write is out, and one once it ends", async () => {
    await ensureRunSheetLoaded("wed_1", async () => sheet(["a"]));
    const end = beginTaskWrite("wed_1");
    const api = server(sheet(["a", "b"]));
    const pending = rereadRunSheet("wed_1", api.fetcher);
    await settle();
    expect(api.reads()).toBe(0);
    end();
    await expect(pending).resolves.toBe(true);
    expect(api.reads()).toBe(1);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("sends one more read, not one per signal, for a burst that arrives while a read is out", async () => {
    await ensureRunSheetLoaded("wed_1", async () => sheet(["a"]));
    const api = server(sheet(["a", "b"]));
    api.hold();
    const first = rereadRunSheet("wed_1", api.fetcher);
    await settle();
    api.set(sheet(["a", "b", "c"]));
    const later = [1, 2, 3, 4].map(() => rereadRunSheet("wed_1", api.fetcher));
    await settle();
    expect(api.reads()).toBe(1);
    api.release();
    await first;
    await Promise.all(later);
    expect(api.reads()).toBe(2);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("reads again on the next open after a checklist write, even with no push", async () => {
    let reads = 0;
    const fetcher = async () => {
      reads += 1;
      return sheet(reads === 1 ? ["a"] : ["a", "timed"]);
    };
    await ensureRunSheetLoaded("wed_1", fetcher);
    await ensureRunSheetLoaded("wed_1", fetcher);
    expect(reads).toBe(1);

    // A time is set on the checklist; no signal reaches this tab.
    const end = beginTaskWrite("wed_1");
    end();

    await expect(ensureRunSheetLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(reads).toBe(2);
    expect(ids()).toEqual(["a", "timed"]);
  });

  it("leaves the checklist's own cache fresh after its write, and the run sheet of another wedding alone", async () => {
    await ensureTasksLoaded("wed_1", async () => []);
    let otherReads = 0;
    await ensureRunSheetLoaded("wed_2", async () => {
      otherReads += 1;
      return sheet(["x"]);
    });
    beginTaskWrite("wed_1")();
    expect(hasCachedTasks("wed_1")).toBe(true);
    await ensureRunSheetLoaded("wed_2", async () => {
      otherReads += 1;
      return sheet(["x"]);
    });
    expect(otherReads).toBe(1);
  });

  it("blanks the rows when a re-read is refused, so a removed helper stops seeing the day", async () => {
    await ensureRunSheetLoaded("wed_1", async () => sheet(["a"]));
    await expect(
      rereadRunSheet("wed_1", async () => {
        throw new RunSheetError(403);
      }),
    ).rejects.toBeInstanceOf(RunSheetError);
    expect(runSheetAccessor("wed_1")()).toBeNull();
  });

  it("marks the run sheet stale without dropping a read in flight", async () => {
    const api = server(sheet(["b"]));
    api.hold();
    const pending = ensureRunSheetLoaded("wed_1", api.fetcher);
    markRunSheetStale("wed_1");
    api.release();
    await expect(pending).resolves.toBe(true);
    expect(ids()).toEqual(["b"]);
    await ensureRunSheetLoaded("wed_1", api.fetcher);
    expect(api.reads()).toBe(2);
  });

  it("an applied schedule change makes both the checklist and the run sheet read again", async () => {
    let taskReads = 0;
    let sheetReads = 0;
    const tasks = async () => {
      taskReads += 1;
      return [];
    };
    const day = async () => {
      sheetReads += 1;
      return sheet([]);
    };
    await ensureTasksLoaded("wed_1", tasks);
    await ensureRunSheetLoaded("wed_1", day);

    scheduleChanged("wed_1");

    await ensureTasksLoaded("wed_1", tasks);
    await ensureRunSheetLoaded("wed_1", day);
    expect([taskReads, sheetReads]).toEqual([2, 2]);
  });

  it("does not take a read that was in flight when it was invalidated", async () => {
    const api = server(sheet(["stale"]));
    api.hold();
    const pending = ensureRunSheetLoaded("wed_1", api.fetcher);
    invalidateRunSheet("wed_1");
    api.release();
    await expect(pending).resolves.toBe(false);
    expect(runSheetAccessor("wed_1")()).toBeNull();
  });

  it("releases the rows with the wedding, and loads nothing for a wedding left", async () => {
    await ensureRunSheetLoaded("wed_1", async () => sheet(["a"]));
    const mounted = runSheetAccessor("wed_1");
    dropWeddingCaches("wed_1");
    expect(mounted()).toBeNull();
    await expect(ensureRunSheetLoaded("wed_1", async () => sheet(["b"]))).resolves.toBe(false);

    await ensureRunSheetLoaded("wed_2", async () => sheet(["a"]));
    dropRunSheet("wed_2");
    expect(runSheetAccessor("wed_2")()).toBeNull();
    closeWeddingScope("wed_3");
    await expect(rereadRunSheet("wed_3", async () => sheet(["a"]))).resolves.toBe(false);
  });
});

describe("readRunSheet", () => {
  it("keeps what it can read and drops what it cannot", () => {
    const read = readRunSheet({
      scope: "own",
      viewerHostId: "whost_me",
      items: [
        {
          kind: "event",
          id: "evt_1",
          name: "Ceremony",
          startAt: "2099-06-20T15:00:00+10:00",
          endAt: "",
          timezone: "Australia/Sydney",
          venueName: "Hall",
          address: "1 Hall St",
        },
        {
          kind: "task",
          id: "tsk_1",
          title: "Bring the rings",
          notes: null,
          status: "done",
          runAt: "2099-06-20T14:30:00+10:00",
          runTimezone: "Australia/Sydney",
          eventId: "evt_1",
          runOffsetMinutes: -30,
          anchored: true,
          eventRemoved: false,
          assigneeHostIds: ["whost_me"],
        },
        // A kind a later API might add, and rows missing what a row needs.
        { kind: "vendor", id: "vnd_1" },
        { kind: "task", title: "No id" },
        { kind: "event", id: "evt_2" },
        "junk",
        null,
      ],
      people: [{ hostId: "whost_me", osnProfileId: "usr_me", handle: "me" }, { hostId: 3 }],
    });
    expect(read.scope).toBe("own");
    expect(read.viewerHostId).toBe("whost_me");
    expect(read.items.map((i) => i.id)).toEqual(["evt_1", "tsk_1"]);
    expect(read.items[1]).toMatchObject({ status: "done", anchored: true, runOffsetMinutes: -30 });
    expect(read.people).toEqual([{ hostId: "whost_me", osnProfileId: "usr_me", handle: "me" }]);
  });

  it("reads a body that is not a run sheet as an empty one, narrowest scope", () => {
    for (const body of [null, "no", 4, { items: "x", people: {} }]) {
      expect(readRunSheet(body)).toEqual({
        scope: "own",
        viewerHostId: null,
        items: [],
        people: [],
      });
    }
  });

  it("fills a task's time fields an older answer leaves out as untimed", () => {
    const read = readRunSheet({
      scope: "full",
      viewerHostId: "w",
      items: [{ kind: "task", id: "t", title: "T", status: "open", assigneeHostIds: [] }],
      people: [],
    });
    expect(read.items[0]).toEqual({
      kind: "task",
      id: "t",
      title: "T",
      notes: null,
      status: "open",
      runAt: null,
      runTimezone: null,
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: false,
      assigneeHostIds: [],
    });
  });
});

describe("fetchRunSheet", () => {
  it("reads the wedding's run sheet", async () => {
    const asked: string[] = [];
    const read = await fetchRunSheet(async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify(sheet(["a"])), { status: 200 });
    }, "wed 1");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/api\/organiser\/weddings\/wed%201\/run-sheet$/);
    expect(read.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("throws the status of a refusal, so the view can tell a locked wedding from a failure", async () => {
    for (const status of [402, 403, 404, 429, 500]) {
      const failure = await fetchRunSheet(
        async () => new Response("{}", { status }),
        "wed_1",
      ).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(RunSheetError);
      expect((failure as RunSheetError).status).toBe(status);
    }
  });
});
