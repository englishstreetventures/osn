import type { RedisClient } from "@shared/redis";
import { createMemoryClient } from "@shared/redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CEREMONY_STORE_MAX,
  createInMemoryCeremonyStore,
  createRedisCeremonyStore,
} from "../../src/lib/ceremony-store";

interface Entry {
  challenge: string;
  attempts: number;
  expiresAt: number;
}

const entry = (challenge: string, attempts = 0): Entry => ({
  challenge,
  attempts,
  expiresAt: Date.now() + 60_000,
});

describe("createInMemoryCeremonyStore", () => {
  it("reports backend + namespace", () => {
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge");
    expect(store.backend).toBe("memory");
    expect(store.namespace).toBe("reg_challenge");
  });

  it("set → get round-trips the value", async () => {
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge");
    await store.set("k1", entry("c1"), 60_000);
    expect(await store.get("k1")).toMatchObject({ challenge: "c1" });
  });

  it("get returns null for unknown / deleted keys", async () => {
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge");
    expect(await store.get("ghost")).toBe(null);
    await store.set("k", entry("c"), 60_000);
    await store.delete("k");
    expect(await store.get("k")).toBe(null);
  });

  it("expires entries past ttlMs (TTL expiry)", async () => {
    const store = createInMemoryCeremonyStore<Entry>("login_challenge");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      await store.set("k", entry("c"), 1_000);
      expect(await store.get("k")).toMatchObject({ challenge: "c" });
      vi.setSystemTime(new Date(1_000_000 + 2_000));
      expect(await store.get("k")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps expired entries on set at most once per debounce window (P-W1 cdl / P-W4)", async () => {
    const onEntryDelta = vi.fn();
    const store = createInMemoryCeremonyStore<Entry>("login_challenge", { onEntryDelta });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      await store.set("stale", entry("s"), 1_000); // first set sweeps (empty) + arms debounce

      // 5s later — "stale" is expired, but we are inside the 30s debounce
      // window, so a write does NOT trigger the O(n) sweep.
      vi.setSystemTime(new Date(1_000_000 + 5_000));
      await store.set("fresh1", entry("f1"), 60_000);
      expect(onEntryDelta).not.toHaveBeenCalledWith(-1, "login_challenge");

      // Past the debounce window — the next write sweeps and evicts "stale".
      vi.setSystemTime(new Date(1_000_000 + 40_000));
      await store.set("fresh2", entry("f2"), 60_000);
      expect(onEntryDelta).toHaveBeenCalledWith(-1, "login_challenge");
      expect(await store.get("stale")).toBe(null);
      expect(await store.get("fresh1")).not.toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries an updated attempts counter across set/get (attempts carry-over)", async () => {
    const store = createInMemoryCeremonyStore<Entry>("step_up_otp");
    await store.set("k", entry("c", 0), 60_000);
    const first = (await store.get("k"))!;
    await store.set("k", { ...first, attempts: first.attempts + 1 }, 60_000);
    expect((await store.get("k"))!.attempts).toBe(1);
  });

  it("bounds the map to CEREMONY_STORE_MAX entries", async () => {
    const store = createInMemoryCeremonyStore<Entry>("cross_device");
    for (let i = 0; i < CEREMONY_STORE_MAX + 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential insert
      await store.set(`k${i}`, entry(`c${i}`), 60_000);
    }
    // Oldest insertions dropped, newest retained.
    expect(await store.get("k0")).toBe(null);
    expect(await store.get(`k${CEREMONY_STORE_MAX + 4}`)).not.toBe(null);
  });

  it("evicts expired entries before FIFO-dropping live ones on a cap breach (T-S1)", async () => {
    const onEntryDelta = vi.fn();
    const store = createInMemoryCeremonyStore<Entry>("cross_device", { onEntryDelta });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      // Fill past the cap (CEREMONY_STORE_MAX + 1 — the bound check runs
      // BEFORE each insert, so the breach is only observed on the next set)
      // with three short-TTL entries interleaved among long-TTL live ones.
      // "live-0" is the OLDEST live insertion — first in FIFO order.
      const shortIndices = new Set([100, 5_000, 9_000]);
      for (let i = 0; i < CEREMONY_STORE_MAX + 1; i++) {
        if (shortIndices.has(i)) {
          // eslint-disable-next-line no-await-in-loop -- sequential insert
          await store.set(`short-${i}`, entry(`s${i}`), 1_000);
        } else {
          // eslint-disable-next-line no-await-in-loop -- sequential insert
          await store.set(`live-${i}`, entry(`l${i}`), 600_000);
        }
      }
      expect(onEntryDelta).not.toHaveBeenCalledWith(-1, "cross_device");

      // Advance past the short TTLs but WITHIN the 30s sweep debounce — the
      // debounced TTL sweep is still armed from the first set, so only the
      // cap-breach path can evict.
      vi.setSystemTime(new Date(1_000_000 + 5_000));
      await store.set("extra", entry("x"), 600_000);

      // The breach swept the three expired entries (size drops back under the
      // cap), so NO live entry was FIFO-dropped: exactly 3 evictions.
      const evictions = onEntryDelta.mock.calls.filter(
        ([delta, ns]) => delta === -1 && ns === "cross_device",
      );
      expect(evictions).toHaveLength(3);
      for (const i of shortIndices) {
        // eslint-disable-next-line no-await-in-loop -- sequential read
        expect(await store.get(`short-${i}`)).toBe(null);
      }
      // The oldest LIVE key survived — expired entries were preferred over
      // FIFO-dropping live insertions.
      expect(await store.get("live-0")).toMatchObject({ challenge: "l0" });
      expect(await store.get("extra")).toMatchObject({ challenge: "x" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits op + entry-delta observer hooks", async () => {
    const onOp = vi.fn();
    const onEntryDelta = vi.fn();
    const store = createInMemoryCeremonyStore<Entry>("reg_challenge", { onOp, onEntryDelta });
    await store.set("k", entry("c"), 60_000);
    await store.get("k");
    await store.delete("k");
    expect(onOp).toHaveBeenCalledWith("set", "reg_challenge");
    expect(onEntryDelta).toHaveBeenCalledWith(1, "reg_challenge");
    expect(onEntryDelta).toHaveBeenCalledWith(-1, "reg_challenge");
  });
});

describe("createRedisCeremonyStore (memory-backed RedisClient)", () => {
  let client: RedisClient;
  beforeEach(() => {
    client = createMemoryClient();
  });

  it("reports backend + namespace", () => {
    const store = createRedisCeremonyStore<Entry>(client, "reg_challenge");
    expect(store.backend).toBe("redis");
    expect(store.namespace).toBe("reg_challenge");
  });

  it("set → get round-trips JSON across two store instances sharing the client", async () => {
    // Simulates a `begin` served by pod A and a `complete` served by pod B:
    // two independent store objects over the same Redis client must agree.
    const podA = createRedisCeremonyStore<Entry>(client, "login_challenge");
    const podB = createRedisCeremonyStore<Entry>(client, "login_challenge");
    await podA.set("k", entry("c"), 60_000);
    expect(await podB.get("k")).toMatchObject({ challenge: "c" });
    await podB.delete("k");
    expect(await podA.get("k")).toBe(null);
  });

  it("attempts carry-over persists through the client", async () => {
    const store = createRedisCeremonyStore<Entry>(client, "step_up_otp");
    await store.set("k", entry("c", 0), 60_000);
    const first = (await store.get("k"))!;
    await store.set("k", { ...first, attempts: first.attempts + 2 }, 60_000);
    expect((await store.get("k"))!.attempts).toBe(2);
  });

  it("namespaces are isolated", async () => {
    const a = createRedisCeremonyStore<Entry>(client, "reg_challenge");
    const b = createRedisCeremonyStore<Entry>(client, "login_challenge");
    await a.set("k", entry("a"), 60_000);
    expect(await b.get("k")).toBe(null);
  });
});

const failingClient = (): RedisClient => ({
  eval: async () => {
    throw new Error("redis down");
  },
  ping: async () => "PONG",
  get: async () => {
    throw new Error("redis down");
  },
  set: async () => {
    throw new Error("redis down");
  },
  del: async () => {
    throw new Error("redis down");
  },
  quit: async () => {},
});

describe("createRedisCeremonyStore fail-conservative behaviour", () => {
  it("get returns null and reports via onError on Redis failure", async () => {
    const onError = vi.fn();
    const store = createRedisCeremonyStore<Entry>(failingClient(), "reg_challenge", {
      observer: { onError },
    });
    expect(await store.get("k")).toBe(null);
    expect(onError).toHaveBeenCalledWith("get", expect.any(Error));
  });

  it("set / delete swallow Redis errors", async () => {
    const onError = vi.fn();
    const store = createRedisCeremonyStore<Entry>(failingClient(), "reg_challenge", {
      observer: { onError },
    });
    await expect(store.set("k", entry("c"), 60_000)).resolves.toBeUndefined();
    await expect(store.delete("k")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("set", expect.any(Error));
    expect(onError).toHaveBeenCalledWith("delete", expect.any(Error));
  });

  it("a throwing onError callback does not break the store contract", async () => {
    const store = createRedisCeremonyStore<Entry>(failingClient(), "reg_challenge", {
      observer: {
        onError: () => {
          throw new Error("logger exploded");
        },
      },
    });
    await expect(store.get("k")).resolves.toBe(null);
    await expect(store.set("k", entry("c"), 60_000)).resolves.toBeUndefined();
  });
});
