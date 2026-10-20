import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetHostsCache,
  ensureHostsLoaded,
  hasCachedHosts,
  type HostSeat,
  hostsAccessor,
  invalidateHosts,
  setFreshHosts,
} from "../../src/lib/hosts-store";
import { dropWeddingCaches, openWeddingCaches } from "../../src/lib/wedding-caches";
import { __resetWeddingScope, closeWeddingScope } from "../../src/lib/wedding-scope";

const seat = (over: Partial<HostSeat>): HostSeat => ({
  hostId: "whost_1",
  osnProfileId: "usr_1",
  role: "editor",
  ...over,
});

/** A load the test settles by hand. */
function held<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { fetcher: () => promise, resolve, reject };
}

beforeEach(() => {
  __resetWeddingScope();
  __resetHostsCache();
});

describe("hosts-store", () => {
  it("asks again after an invalidate, so a drawer never offers who was on the wedding before", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [seat({ hostId: `whost_${calls}` })];
    };
    await ensureHostsLoaded("wed_1", fetcher);
    await ensureHostsLoaded("wed_1", fetcher);
    expect(calls).toBe(1);

    invalidateHosts("wed_1");
    expect(hasCachedHosts("wed_1")).toBe(false);
    // The names stay on screen while the new answer is fetched.
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_1"]);
    await ensureHostsLoaded("wed_1", fetcher);
    expect(calls).toBe(2);
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_2"]);
    expect(hasCachedHosts("wed_1")).toBe(true);
  });

  it("blanks the names and rethrows when a refetch is refused", async () => {
    await ensureHostsLoaded("wed_1", async () => [seat({})]);
    invalidateHosts("wed_1");
    await expect(
      ensureHostsLoaded("wed_1", async () => {
        throw new Error("403");
      }),
    ).rejects.toThrow("403");
    expect(hostsAccessor("wed_1")()).toBeNull();
  });

  it("drops a load that was in flight when the list was invalidated", async () => {
    const old = held<HostSeat[]>();
    const first = ensureHostsLoaded("wed_1", old.fetcher);
    invalidateHosts("wed_1");
    const second = ensureHostsLoaded("wed_1", async () => [seat({ hostId: "whost_new" })]);
    expect(await second).toBe(true);
    old.resolve([seat({ hostId: "whost_old" })]);
    expect(await first).toBe(false);
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_new"]);
  });

  it("shares one request between callers that ask at once", async () => {
    const load = held<HostSeat[]>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return load.fetcher();
    };
    const a = ensureHostsLoaded("wed_1", fetcher);
    const b = ensureHostsLoaded("wed_1", fetcher);
    load.resolve([seat({})]);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(calls).toBe(1);
  });

  // The co-host panel reads the same list on its own mount and hands it over,
  // so a checklist opened after the panel needs no read of its own.
  it("setFreshHosts makes the list fresh, so the next load asks for nothing", async () => {
    invalidateHosts("wed_1");
    setFreshHosts("wed_1", [seat({ hostId: "whost_panel" })]);
    expect(hasCachedHosts("wed_1")).toBe(true);
    let fetched = false;
    const fetcher = async () => {
      fetched = true;
      return [];
    };
    expect(await ensureHostsLoaded("wed_1", fetcher)).toBe(true);
    expect(fetched).toBe(false);
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_panel"]);
  });

  it("setFreshHosts keeps its list over a load that was already in flight", async () => {
    const old = held<HostSeat[]>();
    const pending = ensureHostsLoaded("wed_1", old.fetcher);
    setFreshHosts("wed_1", [seat({ hostId: "whost_panel" })]);
    old.resolve([seat({ hostId: "whost_old" })]);
    expect(await pending).toBe(false);
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_panel"]);
  });

  it("setFreshHosts writes nothing for a wedding the organiser has left", () => {
    closeWeddingScope("wed_1");
    setFreshHosts("wed_1", [seat({ hostId: "whost_late" })]);
    expect(hostsAccessor("wed_1")()).toBeNull();
    expect(hasCachedHosts("wed_1")).toBe(false);
  });
});

describe("hosts-store, what mutation testing asked of it", () => {
  it("answers true from a fresh cache without asking again", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [seat({})];
    };
    expect(await ensureHostsLoaded("wed_1", fetcher)).toBe(true);
    expect(await ensureHostsLoaded("wed_1", fetcher)).toBe(true);
    expect(calls).toBe(1);
  });

  it("asks again after a failed load instead of answering with the old failure", async () => {
    let calls = 0;
    const fails = async (): Promise<HostSeat[]> => {
      calls += 1;
      throw new Error("500");
    };
    await expect(ensureHostsLoaded("wed_1", fails)).rejects.toThrow("500");
    expect(await ensureHostsLoaded("wed_1", async () => [seat({})])).toBe(true);
    expect(calls).toBe(1);
    expect(hostsAccessor("wed_1")()).toHaveLength(1);
  });

  it("lets a failure from before an invalidate blank nothing a newer load put there", async () => {
    const old = held<HostSeat[]>();
    const first = ensureHostsLoaded("wed_1", old.fetcher);
    invalidateHosts("wed_1");
    await ensureHostsLoaded("wed_1", async () => [seat({ hostId: "whost_new" })]);
    old.reject(new Error("403"));
    await expect(first).rejects.toThrow("403");
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_new"]);
  });

  it("keeps the newer load's slot when an older one settles, so callers still share it", async () => {
    const old = held<HostSeat[]>();
    const newer = held<HostSeat[]>();
    let newerCalls = 0;
    const newerFetcher = () => {
      newerCalls += 1;
      return newer.fetcher();
    };
    const first = ensureHostsLoaded("wed_1", old.fetcher);
    invalidateHosts("wed_1");
    const second = ensureHostsLoaded("wed_1", newerFetcher);
    old.resolve([seat({ hostId: "whost_old" })]);
    expect(await first).toBe(false);
    const third = ensureHostsLoaded("wed_1", newerFetcher);
    newer.resolve([seat({ hostId: "whost_new" })]);
    expect(await Promise.all([second, third])).toEqual([true, true]);
    expect(newerCalls).toBe(1);
  });

  it("discards a load from before an invalidate and a drop, even once the wedding is open again", async () => {
    const old = held<HostSeat[]>();
    const pending = ensureHostsLoaded("wed_1", old.fetcher);
    invalidateHosts("wed_1");
    dropWeddingCaches("wed_1");
    openWeddingCaches("wed_1");
    old.resolve([seat({ hostId: "whost_old" })]);
    expect(await pending).toBe(false);
    expect(hostsAccessor("wed_1")()).toBeNull();
  });

  it("loads afresh when the wedding is opened again while a dropped load is still out", async () => {
    const old = held<HostSeat[]>();
    void ensureHostsLoaded("wed_1", old.fetcher);
    dropWeddingCaches("wed_1");
    openWeddingCaches("wed_1");
    expect(await ensureHostsLoaded("wed_1", async () => [seat({ hostId: "whost_new" })])).toBe(
      true,
    );
    expect(hostsAccessor("wed_1")()?.map((s) => s.hostId)).toEqual(["whost_new"]);
    old.resolve([]);
  });
});
