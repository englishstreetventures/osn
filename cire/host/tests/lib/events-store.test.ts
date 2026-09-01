import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEventsCache,
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  hasCachedEvents,
  invalidateEvents,
  setCachedEvents,
} from "../../src/lib/events-store";

/**
 * `ensureEventsLoaded` exists for exactly two behaviours the DOM-level panel
 * tests can't see: (1) two panels mounting in the same tick share ONE fetch,
 * and (2) a rejected fetcher rejects every waiter, clears the in-flight slot,
 * and caches nothing — so the next mount retries instead of awaiting a dead
 * promise forever. Both are pinned here.
 */

const ROW = { id: "evt_1", name: "Reception" } as unknown as EventRow;

describe("ensureEventsLoaded", () => {
  afterEach(() => {
    __resetEventsCache();
  });

  it("dedupes concurrent callers onto one fetch", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await Promise.all([ensureEventsLoaded("wed_1", fetcher), ensureEventsLoaded("wed_1", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hasCachedEvents("wed_1")).toBe(true);
  });

  it("resolves immediately on a cache hit without refetching", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureEventsLoaded("wed_1", fetcher);
    await ensureEventsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves true after a normal load, and true again on a cache hit without refetching", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await expect(ensureEventsLoaded("wed_1", fetcher)).resolves.toBe(true);
    await expect(ensureEventsLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const [a, b] = await Promise.allSettled([
      ensureEventsLoaded("wed_1", failing),
      ensureEventsLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(failing).toHaveBeenCalledTimes(1); // deduped even in failure
    expect(hasCachedEvents("wed_1")).toBe(false); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    const recovering = vi.fn(async () => [ROW]);
    await ensureEventsLoaded("wed_1", recovering);
    expect(recovering).toHaveBeenCalledTimes(1);
    expect(hasCachedEvents("wed_1")).toBe(true);
  });

  it("keys strictly by weddingId — no cross-wedding sharing", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureEventsLoaded("wed_1", fetcher);
    await ensureEventsLoaded("wed_2", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  /**
   * The invalidate-then-reload path a change apply runs. Dropping the cache entry
   * alone leaves the in-flight fetch's own `.then` free to write PRE-mutation rows
   * into a fresh entry — i.e. the row the organiser just deleted comes back. The
   * generation bump discards that abandoned load's result outright.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (rows: EventRow[]) => void;
    const stale = new Promise<EventRow[]>((r) => {
      resolveStale = r;
    });
    const pending = ensureEventsLoaded("wed_1", () => stale);

    invalidateEvents("wed_1");
    resolveStale([{ ...ROW, id: "stale" }]);
    await pending;

    const fresh = vi.fn(async () => [{ ...ROW, id: "fresh" }]);
    await ensureEventsLoaded("wed_1", fresh);

    expect(fresh).toHaveBeenCalledTimes(1);
    expect(eventsAccessor("wed_1")()?.map((r) => r.id)).toEqual(["fresh"]);
    expect(hasCachedEvents("wed_1")).toBe(true);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted `EventTable` captures that accessor at mount. Deleting the
   * map entry on invalidate would leave that accessor pointed at a signal
   * nothing writes to again — a dead view showing stale rows forever. The fix
   * writes THROUGH the signal, so an accessor captured before invalidate
   * still observes it.
   *
   * What changed since: invalidate used to null that signal outright, which
   * flashed the table empty on every organiser edit while the background
   * refetch ran. It now leaves the rows in place and marks the wedding
   * `stale` instead — a mounted table keeps rendering the last-known rows
   * across the invalidate.
   */
  it("a mounted consumer's captured accessor keeps the previous rows after invalidate", async () => {
    await ensureEventsLoaded("wed_1", async () => [ROW]);
    const mounted = eventsAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).toEqual([ROW]);
    invalidateEvents("wed_1");
    expect(mounted()).toEqual([ROW]);
    expect(hasCachedEvents("wed_1")).toBe(false);
  });

  it("ensureEventsLoaded refetches after invalidate and replaces the stale rows on success", async () => {
    await ensureEventsLoaded("wed_1", async () => [{ ...ROW, id: "a" }]);
    invalidateEvents("wed_1");
    await ensureEventsLoaded("wed_1", async () => [{ ...ROW, id: "b" }]);
    expect(eventsAccessor("wed_1")()?.map((r) => r.id)).toEqual(["b"]);
    expect(hasCachedEvents("wed_1")).toBe(true);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known events behind an error banner just because the
   * stale-while-revalidate contract kept the old rows on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureEventsLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureEventsLoaded("wed_1", async () => [ROW]);
    invalidateEvents("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureEventsLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(eventsAccessor("wed_1")()).toBeNull();
  });

  it("__resetEventsCache clears the stale flag along with the cache", async () => {
    await ensureEventsLoaded("wed_1", async () => [ROW]);
    invalidateEvents("wed_1"); // marks wed_1 stale
    __resetEventsCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedEvents` (not `ensureEventsLoaded`) look like a stale hit
    // forever, since only `ensureEventsLoaded`'s success path clears it.
    setCachedEvents("wed_1", [{ ...ROW, id: "b" }]);
    expect(hasCachedEvents("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its event rows nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureEventsLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureEventsLoaded("wed_1", async () => [{ ...ROW, id: "seed" }]);
    invalidateEvents("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureEventsLoaded("wed_1", async () => {
      await gate;
      return [{ ...ROW, id: "abandoned" }];
    });

    invalidateEvents("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await expect(pending).resolves.toBe(false);

    expect(eventsAccessor("wed_1")()?.map((r) => r.id)).toEqual(["seed"]);
    expect(hasCachedEvents("wed_1")).toBe(false);
  });
});
