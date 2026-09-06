import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetGuestsCache,
  ensureGuestsLoaded,
  guestsAccessor,
  hasCachedGuests,
  invalidateGuests,
  type OrganiserGuestRow,
  setCachedGuests,
} from "../../src/lib/guests-store";

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

  it("hasCachedGuests is false after invalidate, so the next load refetches", async () => {
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
   * into a fresh entry — i.e. the row the organiser just deleted comes back. The
   * generation bump discards that abandoned load's result outright.
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
    expect(hasCachedGuests("wed_1")).toBe(true);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted `GuestTable` captures that accessor at mount. Deleting the
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
    const fetcher = vi.fn(async () => [ROW]);
    await ensureGuestsLoaded("wed_1", fetcher);
    const mounted = guestsAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).toEqual([ROW]);
    invalidateGuests("wed_1");
    expect(mounted()).toEqual([ROW]);
    expect(hasCachedGuests("wed_1")).toBe(false);
  });

  it("ensureGuestsLoaded refetches after invalidate and replaces the stale rows on success", async () => {
    await ensureGuestsLoaded("wed_1", async () => [{ ...ROW, familyId: "a" }]);
    invalidateGuests("wed_1");
    await ensureGuestsLoaded("wed_1", async () => [{ ...ROW, familyId: "b" }]);
    expect(guestsAccessor("wed_1")()?.map((r) => r.familyId)).toEqual(["b"]);
    expect(hasCachedGuests("wed_1")).toBe(true);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known guest list behind an error banner just because
   * the stale-while-revalidate contract kept the old rows on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureGuestsLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureGuestsLoaded("wed_1", async () => [ROW]);
    invalidateGuests("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureGuestsLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(guestsAccessor("wed_1")()).toBeNull();
  });

  it("__resetGuestsCache clears the stale flag along with the cache", async () => {
    await ensureGuestsLoaded("wed_1", async () => [ROW]);
    invalidateGuests("wed_1"); // marks wed_1 stale
    __resetGuestsCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedGuests` (not `ensureGuestsLoaded`) look like a stale hit
    // forever, since only `ensureGuestsLoaded`'s success path clears it.
    setCachedGuests("wed_1", [{ ...ROW, familyId: "b" }]);
    expect(hasCachedGuests("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its guest rows nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureGuestsLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureGuestsLoaded("wed_1", async () => [{ ...ROW, familyId: "seed" }]);
    invalidateGuests("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureGuestsLoaded("wed_1", async () => {
      await gate;
      return [{ ...ROW, familyId: "abandoned" }];
    });

    invalidateGuests("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await pending;

    expect(guestsAccessor("wed_1")()?.map((r) => r.familyId)).toEqual(["seed"]);
    expect(hasCachedGuests("wed_1")).toBe(false);
  });
});
