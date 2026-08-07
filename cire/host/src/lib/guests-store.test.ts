import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetGuestsCache,
  ensureGuestsLoaded,
  guestsAccessor,
  hasCachedGuests,
  invalidateGuests,
  type OrganiserGuestRow,
} from "./guests-store";

/**
 * The guests store is the second half of the P-I3 fetch-lift (sibling of
 * `events-store`): it dedupes the guest-list fetch across module switches so a
 * remounting GuestTable / Overview snapshot doesn't refire it. The behaviours the
 * DOM tests can't see are pinned here: concurrent-caller dedupe, cache-hit
 * short-circuit, failure retry, per-wedding keying, and invalidation.
 */

const ROW = { familyId: "fam_1", publicId: "P1" } as unknown as OrganiserGuestRow;

describe("ensureGuestsLoaded", () => {
  afterEach(() => {
    __resetGuestsCache();
  });

  it("dedupes concurrent callers onto one fetch", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await Promise.all([ensureGuestsLoaded("wed_1", fetcher), ensureGuestsLoaded("wed_1", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hasCachedGuests("wed_1")).toBe(true);
  });

  it("resolves immediately on a cache hit without refetching", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureGuestsLoaded("wed_1", fetcher);
    await ensureGuestsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const [a, b] = await Promise.allSettled([
      ensureGuestsLoaded("wed_1", failing),
      ensureGuestsLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(hasCachedGuests("wed_1")).toBe(false);

    const recovering = vi.fn(async () => [ROW]);
    await ensureGuestsLoaded("wed_1", recovering);
    expect(recovering).toHaveBeenCalledTimes(1);
    expect(hasCachedGuests("wed_1")).toBe(true);
  });

  it("keys strictly by weddingId — no cross-wedding sharing", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureGuestsLoaded("wed_1", fetcher);
    await ensureGuestsLoaded("wed_2", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refetches after invalidation (e.g. an import apply)", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureGuestsLoaded("wed_1", fetcher);
    expect(hasCachedGuests("wed_1")).toBe(true);
    invalidateGuests("wed_1");
    expect(hasCachedGuests("wed_1")).toBe(false);
    await ensureGuestsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  /**
   * The invalidate-then-reload path a change apply runs. Dropping the cache entry
   * alone leaves the in-flight fetch's own `.then` free to write PRE-mutation rows
   * into a fresh entry — i.e. the row the organiser just deleted comes back.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (rows: OrganiserGuestRow[]) => void;
    const stale = new Promise<OrganiserGuestRow[]>((r) => {
      resolveStale = r;
    });
    const pending = ensureGuestsLoaded("wed_1", () => stale);

    invalidateGuests("wed_1");
    resolveStale([{ ...ROW, familyId: "stale" }]);
    await pending;

    const fresh = vi.fn(async () => [{ ...ROW, familyId: "fresh" }]);
    await ensureGuestsLoaded("wed_1", fresh);

    expect(fresh).toHaveBeenCalledTimes(1);
    expect(guestsAccessor("wed_1")()?.map((r) => r.familyId)).toEqual(["fresh"]);
  });
});
