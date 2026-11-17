import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWeddingCache } from "../../src/lib/wedding-cache";
import {
  __resetWeddingScope,
  closeWeddingScope,
  openWeddingScope,
} from "../../src/lib/wedding-scope";

/**
 * The factory behind the portal's newer per-wedding caches. Each case is one
 * way such a cache can go wrong: a second request it should not send, rows it
 * should not keep, or rows a torn-down or refused read puts back.
 */

const MAX_AGE = 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createWeddingCache", () => {
  let cache = createWeddingCache<string>({ maxAgeMs: MAX_AGE });

  beforeEach(() => {
    cache = createWeddingCache<string>({ maxAgeMs: MAX_AGE });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetWeddingScope();
  });

  it("sends no second request while the wedding is fresh", async () => {
    const fetcher = vi.fn(async () => "rows");
    await cache.ensureLoaded("wed_1", fetcher);
    await expect(cache.ensureLoaded("wed_1", fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.accessor("wed_1")()).toBe("rows");
  });

  it("shares one request between two loads at once", async () => {
    const fetcher = vi.fn(async () => "rows");
    await Promise.all([cache.ensureLoaded("wed_1", fetcher), cache.ensureLoaded("wed_1", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the value shown after an invalidate, and reads again on the next load", async () => {
    await cache.ensureLoaded("wed_1", async () => "old");
    cache.invalidate("wed_1");
    expect(cache.has("wed_1")).toBe(false);
    expect(cache.accessor("wed_1")()).toBe("old");
    const fetcher = vi.fn(async () => "new");
    await cache.ensureLoaded("wed_1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.accessor("wed_1")()).toBe("new");
  });

  it("caches nothing from a load in flight across an invalidate", async () => {
    const first = deferred<string>();
    const load = cache.ensureLoaded("wed_1", () => first.promise);
    cache.invalidate("wed_1");
    first.resolve("before the write");
    await expect(load).resolves.toBe(false);
    expect(cache.accessor("wed_1")()).toBeNull();
    expect(cache.has("wed_1")).toBe(false);
  });

  it("blanks the value and rethrows when a refetch is refused", async () => {
    await cache.ensureLoaded("wed_1", async () => "rows");
    cache.invalidate("wed_1");
    await expect(
      cache.ensureLoaded("wed_1", async () => {
        throw new Error("403");
      }),
    ).rejects.toThrow("403");
    expect(cache.accessor("wed_1")()).toBeNull();
  });

  it("lets a failed load from before a newer invalidate touch nothing", async () => {
    await cache.ensureLoaded("wed_1", async () => "rows");
    cache.invalidate("wed_1");
    const old = deferred<string>();
    const oldLoad = cache.ensureLoaded("wed_1", () => old.promise);
    cache.invalidate("wed_1");
    await cache.ensureLoaded("wed_1", async () => "newer");
    old.reject(new Error("late failure"));
    await expect(oldLoad).rejects.toThrow("late failure");
    expect(cache.accessor("wed_1")()).toBe("newer");
    expect(cache.has("wed_1")).toBe(true);
  });

  it("reads a value older than its max age again, showing it meanwhile", async () => {
    await cache.ensureLoaded("wed_1", async () => "old");
    vi.advanceTimersByTime(MAX_AGE - 1);
    expect(cache.has("wed_1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cache.has("wed_1")).toBe(false);
    expect(cache.accessor("wed_1")()).toBe("old");
    const next = deferred<string>();
    const load = cache.ensureLoaded("wed_1", () => next.promise);
    expect(cache.accessor("wed_1")()).toBe("old");
    next.resolve("new");
    await load;
    expect(cache.has("wed_1")).toBe(true);
  });

  it("restarts the age on setFresh, and not on setCached", async () => {
    await cache.ensureLoaded("wed_1", async () => "read");
    vi.advanceTimersByTime(MAX_AGE - 10);
    cache.setCached("wed_1", "patched");
    vi.advanceTimersByTime(10);
    expect(cache.has("wed_1")).toBe(false);
    cache.setFresh("wed_1", "answered");
    vi.advanceTimersByTime(MAX_AGE - 1);
    expect(cache.has("wed_1")).toBe(true);
  });

  it("loads nothing and takes no writes for a closed wedding", async () => {
    closeWeddingScope("wed_1");
    const fetcher = vi.fn(async () => "rows");
    await expect(cache.ensureLoaded("wed_1", fetcher)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    cache.setCached("wed_1", "late");
    cache.setFresh("wed_1", "late");
    expect(cache.peek("wed_1")).toBeNull();
    openWeddingScope("wed_1");
  });

  it("forgets a dropped wedding, and a load from before the drop caches nothing", async () => {
    await cache.ensureLoaded("wed_2", async () => "other wedding");
    const inFlight = deferred<string>();
    const accessor = cache.accessor("wed_1");
    const load = cache.ensureLoaded("wed_1", () => inFlight.promise);
    cache.drop("wed_1");
    inFlight.resolve("after the drop");
    await expect(load).resolves.toBe(false);
    expect(accessor()).toBeNull();
    expect(cache.peek("wed_1")).toBeNull();
    expect(cache.accessor("wed_2")()).toBe("other wedding");
  });

  it("drops a load in flight when setFresh answers first", async () => {
    const inFlight = deferred<string>();
    const load = cache.ensureLoaded("wed_1", () => inFlight.promise);
    cache.setFresh("wed_1", "the write's answer");
    inFlight.resolve("older read");
    await expect(load).resolves.toBe(false);
    expect(cache.accessor("wed_1")()).toBe("the write's answer");
    expect(cache.has("wed_1")).toBe(true);
  });

  it("keeps a stale mark through setCached", async () => {
    await cache.ensureLoaded("wed_1", async () => "rows");
    cache.invalidate("wed_1");
    cache.setCached("wed_1", "patched");
    expect(cache.has("wed_1")).toBe(false);
    expect(cache.accessor("wed_1")()).toBe("patched");
  });
});
