import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetEnquiriesCache,
  enquiriesAccessor,
  ensureEnquiriesLoaded,
  hasCachedEnquiries,
  peekCachedEnquiries,
  setCachedEnquiries,
  invalidateEnquiries,
  upsertCachedEnquiry,
  enquiriesNextCursor,
  loadMoreEnquiries,
  type EnquiryListItem,
  type EnquiryPage,
} from "../../src/lib/enquiries-store";
import { __resetWeddingScope, closeWeddingScope } from "../../src/lib/wedding-scope";

const item = (over: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1",
  weddingId: "wed_1",
  directoryVendorId: "dv_1",
  vendorId: "v_1",
  zapChatId: null,
  status: "open",
  createdBy: "p_1",
  quotedMinor: null,
  lastMessageAt: 1,
  createdAt: 1,
  updatedAt: 1,
  vendorName: "Blue Roses",
  category: "florals",
  ...over,
});

const page = (enquiries: EnquiryListItem[], nextCursor: string | null = null): EnquiryPage => ({
  enquiries,
  nextCursor,
});

/** A fetch the test settles by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetEnquiriesCache();
  __resetWeddingScope();
});

describe("enquiries-store", () => {
  it("caches and reads back per wedding", () => {
    setCachedEnquiries("wed_1", [item()]);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(1);
    expect(enquiriesAccessor("wed_1")()![0]!.vendorName).toBe("Blue Roses");
  });

  it("ensureEnquiriesLoaded fetches once and dedups concurrent calls", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return page([item()]);
    };
    await Promise.all([
      ensureEnquiriesLoaded("wed_1", fetcher),
      ensureEnquiriesLoaded("wed_1", fetcher),
    ]);
    expect(calls).toBe(1);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(1);
  });

  it("upsertCachedEnquiry replaces by id and prepends new ones", () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1", status: "open" })]);
    upsertCachedEnquiry("wed_1", item({ id: "enq_1", status: "quoted", quotedMinor: 5000 }));
    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    const rows = peekCachedEnquiries("wed_1")!;
    expect(rows.find((r) => r.id === "enq_1")!.status).toBe("quoted");
    expect(rows.map((r) => r.id)).toContain("enq_2");
  });

  /**
   * #606: `null` means "not loaded", not "no rows". The simplest reachable
   * path has nothing to do with invalidation — `EnquireDialog` calls
   * `upsertCachedEnquiry` from `DirectoryBrowseView`/`VendorsView`, neither of
   * which ever loads the enquiries cache, so this hits a stone-cold cache. A
   * `peek ?? []` here used to collapse the (unfetched) inbox to a single row
   * and flip `hasCachedEnquiries` to true, permanently suppressing the
   * refetch that would have restored the rest.
   */
  it("upsertCachedEnquiry is a no-op against a cold cache (the EnquireDialog path)", () => {
    upsertCachedEnquiry("wed_1", item({ id: "enq_1" }));
    expect(hasCachedEnquiries("wed_1")).toBe(false);
    expect(enquiriesAccessor("wed_1")()).toBeNull();
  });

  /**
   * The second reachable path, introduced by PR #864: invalidate no longer
   * nulls the signal, but the FAILURE branch of `ensureEnquiriesLoaded` still
   * does — so a refused refetch followed by an upsert reaches the same
   * "null cache" state as the cold-start path above.
   */
  it("upsertCachedEnquiry is a no-op after a refused refetch has nulled the signal", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1");
    await expect(
      ensureEnquiriesLoaded("wed_1", async () => {
        throw new Error("403");
      }),
    ).rejects.toThrow("403");
    expect(enquiriesAccessor("wed_1")()).toBeNull();

    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    expect(hasCachedEnquiries("wed_1")).toBe(false);
    expect(enquiriesAccessor("wed_1")()).toBeNull();
  });

  it("invalidateEnquiries clears the cache so a reload refetches", async () => {
    setCachedEnquiries("wed_1", [item()]);
    invalidateEnquiries("wed_1");
    let calls = 0;
    await ensureEnquiriesLoaded("wed_1", async () => {
      calls++;
      return page([]);
    });
    expect(calls).toBe(1);
  });

  it("ensureEnquiriesLoaded refetches after invalidate and replaces the stale rows on success", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_a" })]);
    invalidateEnquiries("wed_1");
    await expect(
      ensureEnquiriesLoaded("wed_1", async () => page([item({ id: "enq_b" })])),
    ).resolves.toBe(true);
    expect(enquiriesAccessor("wed_1")()?.map((e) => e.id)).toEqual(["enq_b"]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
  });

  /**
   * The regression test for the actual bug: `entryFor` mints the signal once
   * and a mounted inbox captures that accessor at mount. Deleting the map
   * entry on invalidate would leave that accessor pointed at a signal nothing
   * writes to again — a dead view showing stale rows forever. The fix writes
   * THROUGH the signal, so an accessor captured before invalidate still
   * observes it.
   *
   * What changed since: invalidate used to null that signal outright, which
   * flashed the inbox empty on every mutation while the background refetch
   * ran. It now leaves the rows in place and marks the wedding `stale`
   * instead — a mounted inbox keeps rendering the last-known rows across the
   * invalidate.
   */
  it("a mounted consumer's captured accessor keeps the previous rows after invalidate", () => {
    setCachedEnquiries("wed_1", [item()]);
    const mounted = enquiriesAccessor("wed_1"); // captured once, as a real mount would
    expect(mounted()).toHaveLength(1);
    invalidateEnquiries("wed_1");
    expect(mounted()).toHaveLength(1);
    expect(hasCachedEnquiries("wed_1")).toBe(false);
  });

  it("ensureEnquiriesLoaded resolves true after a normal load, and true again on a cache hit without refetching", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return page([item()]);
    };
    await expect(ensureEnquiriesLoaded("wed_1", fetcher)).resolves.toBe(true);
    await expect(ensureEnquiriesLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("hasCachedEnquiries is false after invalidate", () => {
    setCachedEnquiries("wed_1", [item()]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
    invalidateEnquiries("wed_1");
    expect(hasCachedEnquiries("wed_1")).toBe(false);
  });

  /**
   * A fetch already in flight when the invalidate runs was issued against
   * PRE-mutation state. Clearing the signal alone would not stop its `.then`
   * writing those stale rows in afterwards — the generation bump does.
   */
  it("does not adopt a fetch that was in flight when the cache was invalidated", async () => {
    let resolveStale!: (p: EnquiryPage) => void;
    const stale = new Promise<EnquiryPage>((r) => {
      resolveStale = r;
    });
    const pending = ensureEnquiriesLoaded("wed_1", () => stale);

    invalidateEnquiries("wed_1");
    resolveStale(page([item({ id: "stale" })]));
    await pending;

    const fresh = async () => page([item({ id: "fresh" })]);
    await ensureEnquiriesLoaded("wed_1", fresh);

    expect(peekCachedEnquiries("wed_1")?.map((r) => r.id)).toEqual(["fresh"]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
  });

  it("upsertCachedEnquiry and peekCachedEnquiries still work after an invalidate/reload cycle", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1");
    await ensureEnquiriesLoaded("wed_1", async () => page([item({ id: "enq_1" })]));
    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    expect(peekCachedEnquiries("wed_1")?.map((r) => r.id)).toContain("enq_2");
  });

  /**
   * The `.finally` that clears the in-flight slot is reached on a rejection
   * too — a rejected fetcher never runs the `.then`, so this is the only path
   * that exercises the guarded clear on a failed load. If the slot were left
   * populated, every later `ensureEnquiriesLoaded` would await a dead promise
   * forever instead of refetching.
   */
  it("rejects every waiter on failure, caches nothing, and retries next call", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("network down");
    };
    const [a, b] = await Promise.allSettled([
      ensureEnquiriesLoaded("wed_1", failing),
      ensureEnquiriesLoaded("wed_1", failing),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1); // deduped even in failure
    expect(hasCachedEnquiries("wed_1")).toBe(false); // nothing poisoned the cache

    // The in-flight slot was cleared — a later call re-invokes the fetcher.
    let recoveringCalls = 0;
    await ensureEnquiriesLoaded("wed_1", async () => {
      recoveringCalls++;
      return page([item()]);
    });
    expect(recoveringCalls).toBe(1);
  });

  /**
   * Security property, not an optimisation: the refetch after invalidate is
   * also the re-authorization check. A demoted organiser must not keep
   * reading the last-known inbox behind an error banner just because the
   * stale-while-revalidate contract kept the old rows on screen — a
   * refused/failed refetch has to blank the signal and rethrow so the caller
   * sees the failure too.
   */
  it("ensureEnquiriesLoaded blanks the signal and rethrows when the refetch is refused", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1");
    const refusal = new Error("403");
    await expect(
      ensureEnquiriesLoaded("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(enquiriesAccessor("wed_1")()).toBeNull();
  });

  it("__resetEnquiriesCache clears the stale flag along with the cache", async () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1" })]);
    invalidateEnquiries("wed_1"); // marks wed_1 stale
    __resetEnquiriesCache();
    // A stale flag surviving the reset would make every future write via
    // `setCachedEnquiries` (not `ensureEnquiriesLoaded`) look like a stale
    // hit forever, since only `ensureEnquiriesLoaded`'s success path clears it.
    setCachedEnquiries("wed_1", [item({ id: "enq_2" })]);
    expect(hasCachedEnquiries("wed_1")).toBe(true);
  });
  /**
   * A load that resolves after a NEWER invalidate has landed must do nothing at
   * all: it neither writes its enquiry rows nor clears the stale mark. Both halves
   * matter — writing would restore state the organiser has already mutated
   * past, and clearing would let the next `ensureEnquiriesLoaded` short-circuit on
   * rows no in-generation load ever confirmed.
   */
  it("a generation-stale success writes no rows and leaves the wedding stale", async () => {
    await ensureEnquiriesLoaded("wed_1", async () => page([item({ id: "seed" })]));
    invalidateEnquiries("wed_1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = ensureEnquiriesLoaded("wed_1", async () => {
      await gate;
      return page([item({ id: "abandoned" })]);
    });

    invalidateEnquiries("wed_1"); // a second invalidate, while that load is still in flight
    release();
    await expect(pending).resolves.toBe(false);

    expect(enquiriesAccessor("wed_1")()?.map((r) => r.id)).toEqual(["seed"]);
    expect(hasCachedEnquiries("wed_1")).toBe(false);
  });
});

describe("enquiries-store paging", () => {
  /** Page one loaded: rows at seconds 300 and 200, with a cursor after the second. */
  async function loadPageOne() {
    await ensureEnquiriesLoaded("wed_1", async () =>
      page(
        [
          item({ id: "enq_c", lastMessageAt: 300_000 }),
          item({ id: "enq_b", lastMessageAt: 200_000 }),
        ],
        "200.enq_b",
      ),
    );
  }

  it("keeps page one's cursor beside its rows", async () => {
    await loadPageOne();
    expect(enquiriesNextCursor("wed_1")()).toBe("200.enq_b");
  });

  it("appends the next page in inbox order and moves the cursor on", async () => {
    await loadPageOne();
    const cursors: string[] = [];
    await expect(
      loadMoreEnquiries("wed_1", async (cursor) => {
        cursors.push(cursor);
        return page([item({ id: "enq_a", lastMessageAt: 100_000 })]);
      }),
    ).resolves.toBe(true);
    expect(cursors).toEqual(["200.enq_b"]);
    expect(peekCachedEnquiries("wed_1")?.map((e) => e.id)).toEqual(["enq_c", "enq_b", "enq_a"]);
    expect(enquiriesNextCursor("wed_1")()).toBeNull();
  });

  it("keeps one copy of an enquiry both hold, the page's, in its place in the order", async () => {
    await loadPageOne();
    // An enquiry an organiser re-opened on a cold row sits in the cache at its
    // own time; the next page brings the server's copy of it.
    upsertCachedEnquiry("wed_1", item({ id: "enq_old", lastMessageAt: 50_000, status: "open" }));
    await loadMoreEnquiries("wed_1", async () =>
      page([
        item({ id: "enq_a", lastMessageAt: 100_000 }),
        item({ id: "enq_old", lastMessageAt: 50_000, status: "quoted" }),
      ]),
    );
    const rows = peekCachedEnquiries("wed_1")!;
    expect(rows.map((e) => e.id)).toEqual(["enq_c", "enq_b", "enq_a", "enq_old"]);
    expect(rows.find((e) => e.id === "enq_old")!.status).toBe("quoted");
  });

  it("sorts a cached row older than the new page below that page's rows", async () => {
    await loadPageOne();
    // A row the cache holds although its page is not loaded yet.
    upsertCachedEnquiry("wed_1", item({ id: "enq_old", lastMessageAt: 50_000 }));
    await loadMoreEnquiries("wed_1", async () =>
      page([item({ id: "enq_a", lastMessageAt: 100_000 })], "100.enq_a"),
    );
    expect(peekCachedEnquiries("wed_1")?.map((e) => e.id)).toEqual([
      "enq_c",
      "enq_b",
      "enq_a",
      "enq_old",
    ]);
  });

  it("orders a tie within one millisecond by id, greater first, as the server does", () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_b", lastMessageAt: 5 })]);
    upsertCachedEnquiry("wed_1", item({ id: "enq_a", lastMessageAt: 5 }));
    upsertCachedEnquiry("wed_1", item({ id: "enq_c", lastMessageAt: 5 }));
    expect(peekCachedEnquiries("wed_1")?.map((e) => e.id)).toEqual(["enq_c", "enq_b", "enq_a"]);
  });

  it("merges into the rows as they are when the page arrives, not when it was asked for", async () => {
    await loadPageOne();
    const next = held<EnquiryPage>();
    const pending = loadMoreEnquiries("wed_1", () => next.promise);
    upsertCachedEnquiry("wed_1", item({ id: "enq_new", lastMessageAt: 400_000 }));
    next.resolve(page([item({ id: "enq_a", lastMessageAt: 100_000 })]));
    await pending;
    expect(peekCachedEnquiries("wed_1")?.map((e) => e.id)).toEqual([
      "enq_new",
      "enq_c",
      "enq_b",
      "enq_a",
    ]);
  });

  it("shares one request between clicks that overlap", async () => {
    await loadPageOne();
    let calls = 0;
    const next = held<EnquiryPage>();
    const fetcher = () => {
      calls++;
      return next.promise;
    };
    const both = Promise.all([
      loadMoreEnquiries("wed_1", fetcher),
      loadMoreEnquiries("wed_1", fetcher),
    ]);
    next.resolve(page([item({ id: "enq_a", lastMessageAt: 100_000 })]));
    expect(await both).toEqual([true, true]);
    expect(calls).toBe(1);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(3);
  });

  it("fetches nothing when there is no next page, nothing loaded, or the wedding is closed", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return page([]);
    };
    // Nothing loaded.
    expect(await loadMoreEnquiries("wed_1", fetcher)).toBe(false);
    // Loaded, last page.
    await ensureEnquiriesLoaded("wed_1", async () => page([item()]));
    expect(await loadMoreEnquiries("wed_1", fetcher)).toBe(false);
    // Closed.
    await ensureEnquiriesLoaded("wed_2", async () => page([item()], "1.enq_1"));
    closeWeddingScope("wed_2");
    expect(await loadMoreEnquiries("wed_2", fetcher)).toBe(false);
    expect(calls).toBe(0);
  });

  // A page from the old cursor, landing after a fresh page one, would sit
  // below it with the rows between them missing.
  it("fetches nothing while page one is stale or being read again", async () => {
    await loadPageOne();
    invalidateEnquiries("wed_1");
    let calls = 0;
    expect(
      await loadMoreEnquiries("wed_1", async () => {
        calls++;
        return page([]);
      }),
    ).toBe(false);
    expect(calls).toBe(0);
  });

  it("drops a page that lands after an invalidation", async () => {
    await loadPageOne();
    const next = held<EnquiryPage>();
    const pending = loadMoreEnquiries("wed_1", () => next.promise);
    invalidateEnquiries("wed_1");
    next.resolve(page([item({ id: "enq_a", lastMessageAt: 100_000 })]));
    expect(await pending).toBe(false);
    expect(peekCachedEnquiries("wed_1")?.map((e) => e.id)).toEqual(["enq_c", "enq_b"]);
  });

  // The next page is a server check like the reload: an organiser who has lost
  // access must not keep reading the pages already loaded behind an error.
  it("blanks the rows and the cursor and rethrows when the next page is refused", async () => {
    await loadPageOne();
    const refusal = new Error("403");
    await expect(
      loadMoreEnquiries("wed_1", async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(enquiriesAccessor("wed_1")()).toBeNull();
    expect(enquiriesNextCursor("wed_1")()).toBeNull();
    expect(hasCachedEnquiries("wed_1")).toBe(false);
  });

  it("leaves rows a newer load owns alone when a superseded page is refused", async () => {
    await loadPageOne();
    const next = held<EnquiryPage>();
    const pending = loadMoreEnquiries("wed_1", () => next.promise);
    invalidateEnquiries("wed_1");
    await ensureEnquiriesLoaded("wed_1", async () => page([item({ id: "enq_fresh" })], "9.enq_x"));
    next.reject(new Error("network down"));
    await expect(pending).rejects.toThrow("network down");
    expect(peekCachedEnquiries("wed_1")?.map((e) => e.id)).toEqual(["enq_fresh"]);
    expect(enquiriesNextCursor("wed_1")()).toBe("9.enq_x");
  });

  it("a refused reload clears the cursor too", async () => {
    await loadPageOne();
    invalidateEnquiries("wed_1");
    await expect(
      ensureEnquiriesLoaded("wed_1", async () => {
        throw new Error("403");
      }),
    ).rejects.toThrow("403");
    expect(enquiriesNextCursor("wed_1")()).toBeNull();
  });
});
