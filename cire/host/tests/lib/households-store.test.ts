import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetHouseholdsCache,
  ensureHouseholdsLoaded,
  hasCachedHouseholds,
  householdsAccessor,
  invalidateHouseholds,
  type OrganiserHouseholdRow,
} from "../../src/lib/households-store";

/**
 * The households store is the third cache the guest editor loads from, and the
 * only one that can describe a household holding no guests. Its correctness is
 * load-bearing in a way the other two aren't: the editor's draft is the whole
 * truth for a save, so a household missing from this list is a DELETION — of the
 * household and of its live claim code. The behaviours the DOM tier structurally
 * cannot observe (it mocks one fetcher and mounts once) are pinned here.
 */

const ROW = { familyId: "fam_1", publicId: "P1" } as unknown as OrganiserHouseholdRow;

/** A promise whose resolution this test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ensureHouseholdsLoaded", () => {
  afterEach(() => {
    __resetHouseholdsCache();
  });

  it("dedupes concurrent callers onto one fetch", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await Promise.all([
      ensureHouseholdsLoaded("wed_1", fetcher),
      ensureHouseholdsLoaded("wed_1", fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hasCachedHouseholds("wed_1")).toBe(true);
  });

  it("resolves immediately on a cache hit without refetching", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves true after a normal load, and true again on a cache hit without refetching", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await expect(ensureHouseholdsLoaded("wed_1", fetcher)).resolves.toBe(true);
    await expect(ensureHouseholdsLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const [a, b] = await Promise.allSettled([
      ensureHouseholdsLoaded("wed_1", failing),
      ensureHouseholdsLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(hasCachedHouseholds("wed_1")).toBe(false);

    const recovering = vi.fn(async () => [ROW]);
    await ensureHouseholdsLoaded("wed_1", recovering);
    expect(recovering).toHaveBeenCalledTimes(1);
    expect(hasCachedHouseholds("wed_1")).toBe(true);
  });

  it("keys strictly by weddingId — no cross-wedding sharing", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    await ensureHouseholdsLoaded("wed_2", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("hasCachedHouseholds is false after invalidate, so the next load refetches", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    expect(hasCachedHouseholds("wed_1")).toBe(true);
    invalidateHouseholds("wed_1");
    expect(hasCachedHouseholds("wed_1")).toBe(false);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  /**
   * The invalidate-then-reload path the editor runs immediately after a
   * successful apply. Without dropping the in-flight promise as well as the
   * cache entry, the reload awaits a fetch that was issued against PRE-mutation
   * state and caches its rows as fresh — i.e. the household (or guest) the
   * organiser just deleted comes straight back.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    const stale = deferred<OrganiserHouseholdRow[]>();
    const first = vi.fn(() => stale.promise);
    const pending = ensureHouseholdsLoaded("wed_1", first);

    invalidateHouseholds("wed_1");
    stale.resolve([{ ...ROW, familyId: "fam_stale" }]);
    await pending;

    const fresh = vi.fn(async () => [{ ...ROW, familyId: "fam_fresh" }]);
    await ensureHouseholdsLoaded("wed_1", fresh);

    expect(fresh).toHaveBeenCalledTimes(1);
    expect(householdsAccessor("wed_1")()?.map((h) => h.familyId)).toEqual(["fam_fresh"]);
    expect(hasCachedHouseholds("wed_1")).toBe(true);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted editor captures that accessor at mount. Deleting the map
   * entry on invalidate would leave that accessor pointed at a signal nothing
   * writes to again — a dead view showing stale rows forever. The fix writes
   * THROUGH the signal, so an accessor captured before invalidate still
   * observes it.
   *
   * What changed since: invalidate used to null that signal outright, which
   * flashed the editor empty on every organiser edit while the background
   * refetch ran. It now leaves the rows in place and marks the wedding
   * `stale` instead — a mounted editor keeps rendering the last-known rows
   * across the invalidate.
   */
  it("a mounted consumer's captured accessor keeps the previous rows after invalidate", async () => {
    const fetcher = vi.fn(async () => [ROW]);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    const mounted = householdsAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).toEqual([ROW]);
    invalidateHouseholds("wed_1");
    expect(mounted()).toEqual([ROW]);
    expect(hasCachedHouseholds("wed_1")).toBe(false);
  });

  it("ensureHouseholdsLoaded refetches after invalidate and replaces the stale rows on success", async () => {
    await ensureHouseholdsLoaded("wed_1", async () => [{ ...ROW, familyId: "a" }]);
    invalidateHouseholds("wed_1");
    await ensureHouseholdsLoaded("wed_1", async () => [{ ...ROW, familyId: "b" }]);
    expect(householdsAccessor("wed_1")()?.map((h) => h.familyId)).toEqual(["b"]);
    expect(hasCachedHouseholds("wed_1")).toBe(true);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known household list behind an error banner just
   * because the stale-while-revalidate contract kept the old rows on screen
   * — a refused/failed refetch has to blank the signal and rethrow so the
   * caller sees the failure too.
   */
  it("ensureHouseholdsLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureHouseholdsLoaded("wed_1", async () => [ROW]);
    invalidateHouseholds("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureHouseholdsLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(householdsAccessor("wed_1")()).toBeNull();
  });

  // households-store has no setCachedHouseholds/peekCachedHouseholds bypass —
  // ensureHouseholdsLoaded is the only way to write its cache, so this can't
  // use the same bypass-write proof the other stores use (seed, reset,
  // setCachedXxx, assert hasCachedXxx is true). That proof needs a write that
  // does NOT itself clear the stale mark, and every write this store exposes
  // is ensureHouseholdsLoaded's own success path, which always clears it —
  // so no assertion built from this API can tell a reset that cleared `stale`
  // apart from one that didn't: hasCachedHouseholds is false either way right
  // after `cache.clear()` (the entry itself is gone), and the very next
  // successful load self-heals a surviving stale mark before anything reads
  // it. What IS real and checkable is the weaker property below: a reset
  // wedding behaves as never-loaded at all, not merely as due for a refetch.
  it("__resetHouseholdsCache clears the cache so a previously-invalidated wedding behaves as never-loaded", async () => {
    await ensureHouseholdsLoaded("wed_1", async () => [ROW]);
    invalidateHouseholds("wed_1"); // marks wed_1 stale
    __resetHouseholdsCache();
    expect(hasCachedHouseholds("wed_1")).toBe(false);
    expect(householdsAccessor("wed_1")()).toBeNull();
    const fetcher = vi.fn(async () => [{ ...ROW, familyId: "fam_after_reset" }]);
    await ensureHouseholdsLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hasCachedHouseholds("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its household rows nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureHouseholdsLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureHouseholdsLoaded("wed_1", async () => [{ ...ROW, familyId: "seed" }]);
    invalidateHouseholds("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureHouseholdsLoaded("wed_1", async () => {
      await gate;
      return [{ ...ROW, familyId: "abandoned" }];
    });

    invalidateHouseholds("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await expect(pending).resolves.toBe(false);

    expect(householdsAccessor("wed_1")()?.map((h) => h.familyId)).toEqual(["seed"]);
    expect(hasCachedHouseholds("wed_1")).toBe(false);
  });
});
