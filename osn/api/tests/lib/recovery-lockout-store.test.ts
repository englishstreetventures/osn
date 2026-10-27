import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryRecoveryLockoutStore,
  RECOVERY_LOCKOUT_THRESHOLD,
} from "../../src/lib/recovery-lockout-store";

describe("createInMemoryRecoveryLockoutStore", () => {
  it("locks after THRESHOLD failures and resets on success", async () => {
    const store = createInMemoryRecoveryLockoutStore();
    expect(await store.status("acc_a")).toEqual({ status: "open", failures: 0 });
    for (let i = 0; i < RECOVERY_LOCKOUT_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential
      await store.recordFailure("acc_a");
    }
    expect(await store.status("acc_a")).toEqual({
      status: "locked",
      failures: RECOVERY_LOCKOUT_THRESHOLD,
    });
    await store.reset("acc_a");
    expect(await store.status("acc_a")).toEqual({ status: "open", failures: 0 });
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
    expect(await store.status("acc_a")).toMatchObject({ status: "locked" });
    expect(await store.status("acc_b")).toEqual({ status: "open", failures: 0 });
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
      expect(await store.status("acc_a")).toMatchObject({ status: "locked" });
      vi.setSystemTime(new Date(1_000_000 + 2_000));
      expect(await store.status("acc_a")).toEqual({ status: "open", failures: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
