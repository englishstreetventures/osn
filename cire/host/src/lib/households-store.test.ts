import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetHouseholdsCache,
  ensureHouseholdsLoaded,
  hasCachedHouseholds,
  householdsAccessor,
  invalidateHouseholds,
  type OrganiserHouseholdRow,
} from "./households-store";

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

  it("refetches after invalidation (e.g. a change apply)", async () => {
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
  });
});
