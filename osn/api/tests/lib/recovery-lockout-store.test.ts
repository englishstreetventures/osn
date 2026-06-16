import type { RedisClient } from "@shared/redis";
import { createMemoryClient } from "@shared/redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryRecoveryLockoutStore,
  createRedisRecoveryLockoutStore,
  RECOVERY_LOCKOUT_THRESHOLD,
} from "../../src/lib/recovery-lockout-store";

describe("createInMemoryRecoveryLockoutStore", () => {
  it("reports backend", () => {
    expect(createInMemoryRecoveryLockoutStore().backend).toBe("memory");
  });

  it("locks after THRESHOLD failures and resets on success", async () => {
    const store = createInMemoryRecoveryLockoutStore();
    expect(await store.isLocked("acc_a")).toBe(false);
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential
      await store.recordFailure("acc_a");
    }
    expect(await store.isLocked("acc_a")).toBe(true);
    await store.reset("acc_a");
    expect(await store.isLocked("acc_a")).toBe(false);
  });

  it("recordFailure returns the running count", async () => {
    const store = createInMemoryRecoveryLockoutStore();
    expect(await store.recordFailure("acc_a")).toBe(1);
    expect(await store.recordFailure("acc_a")).toBe(2);
  });

  it("isolates counters per account", async () => {
    const store = createInMemoryRecoveryLockoutStore();
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential
      await store.recordFailure("acc_a");
    }
    expect(await store.isLocked("acc_a")).toBe(true);
    expect(await store.isLocked("acc_b")).toBe(false);
  });

  it("expires the lockout window (TTL expiry)", async () => {
    const store = createInMemoryRecoveryLockoutStore({ lockoutMs: 1_000 });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential
        await store.recordFailure("acc_a");
      }
      expect(await store.isLocked("acc_a")).toBe(true);
      vi.setSystemTime(new Date(1_000_000 + 2_000));
      expect(await store.isLocked("acc_a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createRedisRecoveryLockoutStore (memory-backed RedisClient)", () => {
  let client: RedisClient;
  beforeEach(() => {
    client = createMemoryClient();
  });

  it("reports backend", () => {
    expect(createRedisRecoveryLockoutStore(client).backend).toBe("redis");
  });

  it("locks after THRESHOLD failures across two store instances sharing the client", async () => {
    const podA = createRedisRecoveryLockoutStore(client);
    const podB = createRedisRecoveryLockoutStore(client);
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential, alternating pods
      await (i % 2 === 0 ? podA : podB).recordFailure("acc_a");
    }
    // A failure recorded on either pod is visible to the other.
    expect(await podB.isLocked("acc_a")).toBe(true);
    await podA.reset("acc_a");
    expect(await podB.isLocked("acc_a")).toBe(false);
  });

  it("per-account isolation through the client", async () => {
    const store = createRedisRecoveryLockoutStore(client);
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential
      await store.recordFailure("acc_a");
    }
    expect(await store.isLocked("acc_a")).toBe(true);
    expect(await store.isLocked("acc_b")).toBe(false);
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

describe("createRedisRecoveryLockoutStore fail-open behaviour", () => {
  it("isLocked returns false (fail-open) on Redis error", async () => {
    const onError = vi.fn();
    const store = createRedisRecoveryLockoutStore(failingClient(), { onError });
    expect(await store.isLocked("acc_a")).toBe(false);
    expect(onError).toHaveBeenCalledWith("is_locked", expect.any(Error));
  });

  it("recordFailure returns 0 and reset swallows on Redis error", async () => {
    const onError = vi.fn();
    const store = createRedisRecoveryLockoutStore(failingClient(), { onError });
    expect(await store.recordFailure("acc_a")).toBe(0);
    await expect(store.reset("acc_a")).resolves.toBeUndefined();
  });
});
