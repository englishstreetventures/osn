import type { RedisClient } from "@shared/redis";
import { createMemoryClient } from "@shared/redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryRecoveryLockoutStore,
  createRedisRecoveryLockoutStore,
  RECOVERY_LOCKOUT_THRESHOLD,
} from "../../src/lib/recovery-lockout-store";

describe("createInMemoryRecoveryLockoutStore", () => {
  it("locks after THRESHOLD failures and resets on success", async () => {
    const store = createInMemoryRecoveryLockoutStore();
    expect(await store.status("acc_a")).toBe("open");
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential
      await store.recordFailure("acc_a");
    }
    expect(await store.status("acc_a")).toBe("locked");
    await store.reset("acc_a");
    expect(await store.status("acc_a")).toBe("open");
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
    expect(await store.status("acc_a")).toBe("locked");
    expect(await store.status("acc_b")).toBe("open");
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
      expect(await store.status("acc_a")).toBe("locked");
      vi.setSystemTime(new Date(1_000_000 + 2_000));
      expect(await store.status("acc_a")).toBe("open");
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

  it("locks after THRESHOLD failures across two store instances sharing the client", async () => {
    const podA = createRedisRecoveryLockoutStore(client);
    const podB = createRedisRecoveryLockoutStore(client);
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential, alternating pods
      await (i % 2 === 0 ? podA : podB).recordFailure("acc_a");
    }
    // A failure recorded on either pod is visible to the other.
    expect(await podB.status("acc_a")).toBe("locked");
    await podA.reset("acc_a");
    expect(await podB.status("acc_a")).toBe("open");
  });

  it("per-account isolation through the client", async () => {
    const store = createRedisRecoveryLockoutStore(client);
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential
      await store.recordFailure("acc_a");
    }
    expect(await store.status("acc_a")).toBe("locked");
    expect(await store.status("acc_b")).toBe("open");
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

describe("createRedisRecoveryLockoutStore on a failing client", () => {
  it("answers unknown for status and recordFailure, and reset swallows", async () => {
    const onError = vi.fn();
    const store = createRedisRecoveryLockoutStore(failingClient(), { onError });
    expect(await store.status("acc_a")).toBe("unknown");
    expect(await store.recordFailure("acc_a")).toBe("unknown");
    await expect(store.reset("acc_a")).resolves.toBeUndefined();
    expect(onError.mock.calls.map((c) => c[0])).toEqual(["is_locked", "record", "reset"]);
  });
});
