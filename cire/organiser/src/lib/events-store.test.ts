import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEventsCache,
  ensureEventsLoaded,
  type EventRow,
  hasCachedEvents,
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
});
