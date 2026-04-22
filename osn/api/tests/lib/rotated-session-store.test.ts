import type { RedisClient } from "@shared/redis";
import { createMemoryClient } from "@shared/redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryRotatedSessionStore,
  createRedisRotatedSessionStore,
  ROTATED_SESSIONS_MAX,
} from "../../src/lib/rotated-session-store";

describe("createInMemoryRotatedSessionStore", () => {
  it("reports its backend", () => {
    const store = createInMemoryRotatedSessionStore();
    expect(store.backend).toBe("memory");
  });

  it("track → check returns the familyId", async () => {
    const store = createInMemoryRotatedSessionStore();
    await store.track("hash1", "fam1", 60_000);
    expect(await store.check("hash1")).toBe("fam1");
  });

  it("check returns null for unknown hashes", async () => {
    const store = createInMemoryRotatedSessionStore();
    expect(await store.check("unknown")).toBe(null);
  });

  it("sweeps entries older than ttlMs on track", async () => {
    const store = createInMemoryRotatedSessionStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      await store.track("hash_old", "fam_old", 60_000);
      expect(await store.check("hash_old")).toBe("fam_old");

      // Advance well past the TTL then insert a new entry — the sweep runs
      // at track-time and should evict the stale record.
      vi.setSystemTime(new Date(1_000_000 + 120_000));
      await store.track("hash_new", "fam_new", 60_000);

      expect(await store.check("hash_old")).toBe(null);
      expect(await store.check("hash_new")).toBe("fam_new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokeFamily clears every hash in the family", async () => {
    const store = createInMemoryRotatedSessionStore();
    await store.track("h1", "famA", 60_000);
    await store.track("h2", "famA", 60_000);
    await store.track("h3", "famB", 60_000);

    await store.revokeFamily("famA");

    expect(await store.check("h1")).toBe(null);
    expect(await store.check("h2")).toBe(null);
    expect(await store.check("h3")).toBe("famB");
  });

  it("revokeFamily keeps the FIFO queue aligned with live entries (P-I1)", async () => {
    // Regression guard: prior to P-I1 the `order` queue retained revoked
    // keys, so after enough revocations the cap check could evict still-live
    // entries prematurely. Exercise the alignment by revoking half, then
    // filling to just past the cap — the retained entries must survive.
    const store = createInMemoryRotatedSessionStore();
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential tracking
      await store.track(`keep${i}`, "famKeep", 60_000);
    }
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential tracking
      await store.track(`drop${i}`, "famDrop", 60_000);
    }
    await store.revokeFamily("famDrop");

    // Force a sweep at the cap; if revoked keys were still in `order`, the
    // cap-driven eviction would pop them (harmless) or pop live keys (bad).
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential tracking
      await store.track(`new${i}`, "famNew", 60_000);
    }
    const keepChecks = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.check(`keep${i}`)),
    );
    for (const result of keepChecks) expect(result).toBe("famKeep");
  });

  it("bounds the map to ROTATED_SESSIONS_MAX entries", async () => {
    const store = createInMemoryRotatedSessionStore();
    // Use a TTL well longer than the test takes so sweeps are bound-driven,
    // not time-driven. Insert MAX+10 entries and confirm the oldest are gone.
    for (let i = 0; i < ROTATED_SESSIONS_MAX + 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential tracking
      await store.track(`h${i}`, "fam", 60_000);
    }
    // The first 10 should have been evicted; the newest must still be present.
    expect(await store.check("h0")).toBe(null);
    expect(await store.check(`h${ROTATED_SESSIONS_MAX + 9}`)).toBe("fam");
  });
});

describe("createRedisRotatedSessionStore (memory-backed RedisClient)", () => {
  let client: RedisClient;
  beforeEach(() => {
    // The shared memory client supports get/set/del which is all this store
    // needs — no Lua scripts. That lets us exercise the real Redis impl here.
    client = createMemoryClient();
  });

  it("reports its backend", () => {
    const store = createRedisRotatedSessionStore(client);
    expect(store.backend).toBe("redis");
  });

  it("track → check returns the familyId", async () => {
    const store = createRedisRotatedSessionStore(client);
    await store.track("hashR", "famR", 60_000);
    expect(await store.check("hashR")).toBe("famR");
  });

  it("check returns null for unknown hashes", async () => {
    const store = createRedisRotatedSessionStore(client);
    expect(await store.check("ghost")).toBe(null);
  });

  it("revokeFamily is a no-op (TTL drives eviction on the Redis backend)", async () => {
    // Deliberate design: the DB-level DELETE FROM sessions is the
    // authoritative family revocation. Redis hash keys expire under their
    // own PX TTL; skipping proactive cleanup keeps `track` single-round-trip
    // and removes the S-L1/S-L3/P-W1/P-W2 concerns raised against the
    // prior family-set design. A repeat replay post-revocation just
    // re-fires the metric, which is informative rather than harmful.
    const store = createRedisRotatedSessionStore(client);
    await store.track("h1", "famA", 60_000);
    await store.revokeFamily("famA");
    expect(await store.check("h1")).toBe("famA");
  });

  it("isolates namespaces between stores", async () => {
    const a = createRedisRotatedSessionStore(client, { namespace: "ns-a" });
    const b = createRedisRotatedSessionStore(client, { namespace: "ns-b" });

    await a.track("hash", "famA", 60_000);
    expect(await a.check("hash")).toBe("famA");
    // Same hash key, different namespace → miss.
    expect(await b.check("hash")).toBe(null);
  });
});

const makeFailingClient = (): RedisClient => ({
  eval: async () => {
    throw new Error("redis down");
  },
  ping: async () => {
    throw new Error("redis down");
  },
  get: async () => {
    throw new Error("redis down");
  },
  set: async () => {
    throw new Error("redis down");
  },
  del: async () => {
    throw new Error("redis down");
  },
  quit: async () => {
    /* noop */
  },
});

describe("createRedisRotatedSessionStore fail-open behaviour", () => {
  it("check returns null on Redis error and reports it via onError", async () => {
    const onError = vi.fn();
    const store = createRedisRotatedSessionStore(makeFailingClient(), { onError });

    expect(await store.check("h")).toBe(null);
    expect(onError).toHaveBeenCalledWith("check", expect.any(Error));
  });

  it("track swallows Redis errors and reports via onError", async () => {
    const onError = vi.fn();
    const store = createRedisRotatedSessionStore(makeFailingClient(), { onError });

    await expect(store.track("h", "f", 60_000)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("track", expect.any(Error));
  });

  it("revokeFamily is a no-op and touches no Redis calls (cannot fail)", async () => {
    // Because Redis revokeFamily is a deliberate no-op, a uniformly-failing
    // client must never invoke onError — there are no Redis operations to
    // fail in the first place.
    const onError = vi.fn();
    const store = createRedisRotatedSessionStore(makeFailingClient(), { onError });

    await expect(store.revokeFamily("f")).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

const throwingOnError = (): void => {
  throw new Error("logger exploded");
};

describe("createRedisRotatedSessionStore misbehaving-callback resilience", () => {
  it("onError callbacks that throw do not break the store contract", async () => {
    // `index.ts` wires onError to an Effect.runPromise/logger call that
    // could itself throw if the observability layer is misconfigured. The
    // store contract must be robust to that: a crashing callback cannot
    // cascade into a thrown rejection from track/check/revokeFamily, or
    // reuse detection would silently hard-fail on logger misconfiguration.
    const store = createRedisRotatedSessionStore(makeFailingClient(), {
      onError: throwingOnError,
    });

    await expect(store.track("h", "f", 60_000)).resolves.toBeUndefined();
    await expect(store.check("h")).resolves.toBe(null);
    await expect(store.revokeFamily("f")).resolves.toBeUndefined();
  });
});
