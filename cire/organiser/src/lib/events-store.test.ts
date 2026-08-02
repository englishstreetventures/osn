import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEventsCache,
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  hasCachedEvents,
  invalidateEvents,
} from "./events-store";

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
   * into a fresh entry — i.e. the row the organiser just deleted comes back.
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
  });
});
