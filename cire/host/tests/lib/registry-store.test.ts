import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRegistryCache,
  ensureRegistryLoaded,
  type GiftLogEntry,
  hasCachedRegistry,
  invalidateRegistry,
  peekCachedRegistry,
  registryAccessor,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
  stillWanted,
} from "../../src/lib/registry-store";

const item = (over: Partial<RegistryItem>): RegistryItem => ({
  id: "itm_1",
  weddingId: "wed_1",
  kind: "product",
  title: "Copper pan",
  description: null,
  imageKey: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: 12_000,
  quantityWanted: 1,
  quantityClaimed: 0,
  allowPartial: false,
  targetMinor: null,
  category: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const gift = (over: Partial<GiftLogEntry>): GiftLogEntry => ({
  kind: "claim",
  id: "clm_1",
  itemId: "itm_1",
  itemTitle: "Copper pan",
  familyId: "fam_1",
  familyName: "The Nguyens",
  displayName: null,
  quantity: 1,
  status: "reserved",
  note: null,
  amountMinor: null,
  currency: null,
  primaryAmountMinor: null,
  primaryCurrency: null,
  fxRate: null,
  thankedAt: null,
  createdAt: 1,
  ...over,
});

const snapshot = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot => ({
  settings: {
    weddingId: "wed_1",
    published: false,
    headline: null,
    message: null,
    cashGiftsEnabled: false,
    shippingAddress: null,
    shippingVisibleFrom: null,
    stripeAccountId: null,
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    updatedAt: null,
  },
  items: [item({})],
  gifts: [gift({})],
  giftsHasMore: false,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  ...over,
});

beforeEach(() => __resetRegistryCache());

describe("registry-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot();
    };
    await ensureRegistryLoaded("wed_1", fetcher);
    await ensureRegistryLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(registryAccessor("wed_1")()?.items.length).toBe(1);
  });

  it("caches the whole snapshot, not just the items", async () => {
    // The gift log, the settings and the currency arrive in the SAME response as
    // the items; caching only the item list would send the gifts sub-view back to
    // the network for data it already had.
    await ensureRegistryLoaded("wed_1", async () =>
      snapshot({ gifts: [gift({ id: "a" }), gift({ id: "b" })], giftsHasMore: true }),
    );
    const snap = peekCachedRegistry("wed_1")!;
    expect(snap.gifts.length).toBe(2);
    expect(snap.giftsHasMore).toBe(true);
    expect(snap.currency).toBe("AUD");
    expect(snap.settings.weddingId).toBe("wed_1");
  });

  it("invalidateRegistry marks the cache stale without nulling the raw signal", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot());
    expect(peekCachedRegistry("wed_1")).not.toBeNull();
    invalidateRegistry("wed_1");
    // `hasCachedRegistry` is the miss check now — it consults the `stale` set,
    // which is exactly what makes the next `ensureRegistryLoaded` refetch.
    expect(hasCachedRegistry("wed_1")).toBe(false);
    // `peekCachedRegistry` reads the signal directly and doesn't consult
    // `stale`, so it still sees the last-known snapshot here — the same known
    // limitation (tracked in #620) noted on the vendors store.
    expect(peekCachedRegistry("wed_1")).not.toBeNull();
  });

  it("inflight deduplication: two concurrent calls fire the fetcher once", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot();
    };
    // Fire both before either resolves.
    const [p1, p2] = [
      ensureRegistryLoaded("wed_2", fetcher),
      ensureRegistryLoaded("wed_2", fetcher),
    ];
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it("stillWanted floors at zero when claims overshoot", () => {
    expect(stillWanted(item({ quantityWanted: 3, quantityClaimed: 1 }))).toBe(2);
    // Claims race against each other, so one can land past the wanted count. A
    // negative "still wanted" would read as a fault.
    expect(stillWanted(item({ quantityWanted: 1, quantityClaimed: 2 }))).toBe(0);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted Registry view captures that accessor at mount. Deleting
   * the map entry on invalidate would leave that accessor pointed at a
   * signal nothing writes to again — a dead view showing a stale snapshot
   * forever. The fix writes THROUGH the signal, so an accessor captured
   * before invalidate still observes the transition.
   */
  it("a mounted consumer's captured accessor keeps the previous snapshot after invalidate", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot());
    const mounted = registryAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).not.toBeNull();
    invalidateRegistry("wed_1");
    expect(mounted()).not.toBeNull();
    expect(hasCachedRegistry("wed_1")).toBe(false);
  });

  it("ensureRegistryLoaded resolves true after a normal load, and true again on a cache hit without refetching", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot();
    };
    await expect(ensureRegistryLoaded("wed_1", fetcher)).resolves.toBe(true);
    await expect(ensureRegistryLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("hasCachedRegistry is false after invalidate, so the next load refetches", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot());
    expect(hasCachedRegistry("wed_1")).toBe(true);
    invalidateRegistry("wed_1");
    expect(hasCachedRegistry("wed_1")).toBe(false);
    let calls = 0;
    await ensureRegistryLoaded("wed_1", async () => {
      calls += 1;
      return snapshot();
    });
    expect(calls).toBe(1);
  });

  /**
   * A fetch already in flight when the invalidate runs was issued against
   * PRE-mutation state. Clearing the signal alone would not stop its `.then`
   * writing that stale snapshot in afterwards — the generation bump does.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (s: RegistrySnapshot) => void;
    const stale = new Promise<RegistrySnapshot>((r) => {
      resolveStale = r;
    });
    const pending = ensureRegistryLoaded("wed_1", () => stale);

    invalidateRegistry("wed_1");
    resolveStale(snapshot({ items: [item({ id: "stale" })] }));
    await pending;

    const fresh = async () => snapshot({ items: [item({ id: "fresh" })] });
    await ensureRegistryLoaded("wed_1", fresh);

    expect(registryAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["fresh"]);
    expect(hasCachedRegistry("wed_1")).toBe(true);
  });

  it("peekCachedRegistry reflects fresh data after an invalidate/reload cycle", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "a" })] }));
    invalidateRegistry("wed_1");
    await ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "b" })] }));
    expect(peekCachedRegistry("wed_1")?.items.map((i) => i.id)).toEqual(["b"]);
  });

  /**
   * The `.finally` that clears the in-flight slot is reached on a rejection
   * too — a rejected fetcher never runs the `.then`, so this is the only path
   * that exercises the guarded clear on a failed load. If the slot were left
   * populated, every later `ensureRegistryLoaded` would await a dead promise
   * forever instead of refetching.
   */
  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const [a, b] = await Promise.allSettled([
      ensureRegistryLoaded("wed_1", failing),
      ensureRegistryLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1); // deduped even in failure
    expect(hasCachedRegistry("wed_1")).toBe(false); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    let recoveringCalls = 0;
    await ensureRegistryLoaded("wed_1", async () => {
      recoveringCalls += 1;
      return snapshot();
    });
    expect(recoveringCalls).toBe(1);
  });

  it("ensureRegistryLoaded refetches after invalidate and replaces the stale snapshot on success", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "a" })] }));
    invalidateRegistry("wed_1");
    await expect(
      ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "b" })] })),
    ).resolves.toBe(true);
    expect(registryAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["b"]);
    expect(hasCachedRegistry("wed_1")).toBe(true);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known registry behind an error banner just because the
   * stale-while-revalidate contract kept the old snapshot on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureRegistryLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "a" })] }));
    invalidateRegistry("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureRegistryLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(registryAccessor("wed_1")()).toBeNull();
  });

  it("__resetRegistryCache clears the stale flag along with the cache", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "a" })] }));
    invalidateRegistry("wed_1"); // marks wed_1 stale
    __resetRegistryCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedRegistry` (not `ensureRegistryLoaded`) look like a stale hit
    // forever, since only `ensureRegistryLoaded`'s success path clears it.
    setCachedRegistry("wed_1", snapshot({ items: [item({ id: "b" })] }));
    expect(hasCachedRegistry("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its registry items nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureRegistryLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot({ items: [item({ id: "seed" })] }));
    invalidateRegistry("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureRegistryLoaded("wed_1", async () => {
      await gate;
      return snapshot({ items: [item({ id: "abandoned" })] });
    });

    invalidateRegistry("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await expect(pending).resolves.toBe(false);

    expect(registryAccessor("wed_1")()?.items.map((i) => i.id)).toEqual(["seed"]);
    expect(hasCachedRegistry("wed_1")).toBe(false);
  });
});
