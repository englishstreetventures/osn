import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetHostsCache,
  ensureHostsLoaded,
  hasCachedHosts,
  type HostSeat,
  hostsAccessor,
  invalidateHosts,
} from "../../src/lib/hosts-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";

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
});
