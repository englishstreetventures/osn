import { describe, expect, it, vi } from "vitest";

import {
  createDurableCeremonyStore,
  createDurableCoordination,
  createDurableJtiStore,
  createDurableLockoutStore,
} from "../../../src/lib/coordination/durable";
import * as metrics from "../../../src/metrics";
import { createFakeNamespace } from "../../helpers/coordination-namespace";

const KEY = "acc_secretkey1";
const VALUE = { codeHash: "hash-that-must-not-leak", attempts: 0, expiresAt: 1 };

describe("durable ceremony store", () => {
  // F-CL5
  it("rejects set, get, delete and consume when the object call fails", async () => {
    const fake = createFakeNamespace();
    fake.failWhen(() => true);
    const onError = vi.fn();
    const store = createDurableCeremonyStore<typeof VALUE>(fake.ns, "step_up_otp", onError);

    await expect(store.set(KEY, VALUE, 60_000)).rejects.toThrow(/object unavailable/);
    await expect(store.get(KEY)).rejects.toThrow(/object unavailable/);
    await expect(store.delete(KEY)).rejects.toThrow(/object unavailable/);
    await expect(store.consume(KEY)).rejects.toThrow(/object unavailable/);
    expect(onError.mock.calls.map(([named, op]) => `${named}.${op}`)).toEqual([
      "step_up_otp.write",
      "step_up_otp.read",
      "step_up_otp.remove",
      "step_up_otp.remove",
    ]);
  });

  // F-CL6
  it("round-trips a value through JSON and expires it with its TTL", async () => {
    const fake = createFakeNamespace();
    const store = createDurableCeremonyStore<typeof VALUE>(fake.ns, "step_up_otp", vi.fn());
    const value = { ...VALUE, nested: { list: [1, "two"] } };

    await store.set(KEY, value, 60_000);
    expect(await store.get(KEY)).toEqual(value);
    expect(await store.consume(KEY)).toBe(true);
    expect(await store.consume(KEY)).toBe(false);
    expect(await store.get(KEY)).toBeNull();

    vi.useFakeTimers();
    try {
      await store.set(KEY, value, 1_000);
      vi.advanceTimersByTime(1_001);
      expect(await store.get(KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the entry when written with a TTL at or below zero", async () => {
    const fake = createFakeNamespace();
    const store = createDurableCeremonyStore<typeof VALUE>(fake.ns, "step_up_otp", vi.fn());
    await store.set(KEY, VALUE, 60_000);
    await store.set(KEY, VALUE, 0);
    expect(await store.get(KEY)).toBeNull();
  });

  it("reads a stored value that is not JSON as absent, without reporting a failure", async () => {
    const fake = createFakeNamespace();
    const onError = vi.fn();
    const store = createDurableCeremonyStore<typeof VALUE>(fake.ns, "step_up_otp", onError);
    await fake.ns.getByName(`step_up_otp:${KEY}`).write("{not json", 60_000);

    await expect(store.get(KEY)).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("names one object per store and key", async () => {
    const fake = createFakeNamespace();
    const a = createDurableCeremonyStore(fake.ns, "step_up_otp", vi.fn());
    const b = createDurableCeremonyStore(fake.ns, "pending_email_change", vi.fn());
    await a.get(KEY);
    await b.get(KEY);
    expect(fake.names).toEqual([`step_up_otp:${KEY}`, `pending_email_change:${KEY}`]);
  });
});

describe("durable step-up token guard", () => {
  // F-CL7
  it("rejects when the object call fails, rather than answering either way", async () => {
    const fake = createFakeNamespace();
    fake.failWhen(() => true);
    const store = createDurableJtiStore(fake.ns, vi.fn());
    await expect(store.consume("jti_1", 300_000)).rejects.toThrow(/object unavailable/);
  });

  it("accepts a token id once", async () => {
    const fake = createFakeNamespace();
    const store = createDurableJtiStore(fake.ns, vi.fn());
    const results = await Promise.all([
      store.consume("jti_1", 300_000),
      store.consume("jti_1", 300_000),
    ]);
    expect(results.toSorted()).toEqual([false, true]);
  });
});

describe("durable lockout counters", () => {
  // F-CL8
  it.each(["recovery_lockout", "recovery_otp_lockout", "totp_lockout"] as const)(
    "%s answers unknown on a failed call, reports it, and swallows a failed reset",
    async (name) => {
      const fake = createFakeNamespace();
      fake.failWhen(() => true);
      const onError = vi.fn();
      const store = createDurableLockoutStore(
        fake.ns,
        name,
        { threshold: 5, lockoutMs: 900_000 },
        onError,
      );
      expect(await store.status(KEY)).toBe("unknown");
      expect(await store.recordFailure(KEY)).toBe("unknown");
      await expect(store.reset(KEY)).resolves.toBeUndefined();
      expect(onError.mock.calls.map(([named, op]) => `${named}.${op}`)).toEqual([
        `${name}.count`,
        `${name}.increment`,
        `${name}.remove`,
      ]);
    },
  );

  it("locks at the threshold inside the window and opens on reset", async () => {
    const fake = createFakeNamespace();
    const store = createDurableLockoutStore(
      fake.ns,
      "totp_lockout",
      { threshold: 3, lockoutMs: 900_000 },
      vi.fn(),
    );
    expect(await store.recordFailure(KEY)).toBe(1);
    expect(await store.recordFailure(KEY)).toBe(2);
    expect(await store.status(KEY)).toBe("open");
    expect(await store.recordFailure(KEY)).toBe(3);
    expect(await store.status(KEY)).toBe("locked");
    await store.reset(KEY);
    expect(await store.status(KEY)).toBe("open");
  });

  // F-CL9
  it("keeps the three counters apart for one account", async () => {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(fake.ns, vi.fn());
    await bundle.recoveryLockoutStore.recordFailure(KEY);
    await bundle.recoveryOtpLockoutStore.recordFailure(KEY);
    await bundle.totpLockoutStore.recordFailure(KEY);
    expect(new Set(fake.names).size).toBe(3);
    expect(await bundle.recoveryLockoutStore.recordFailure(KEY)).toBe(2);
    expect(await bundle.totpLockoutStore.recordFailure(KEY)).toBe(2);
  });
});

describe("what a failed call reports", () => {
  // F-CL11
  it("never carries a key, an IP, an account or a value", async () => {
    const fake = createFakeNamespace();
    fake.failWhen(() => true);
    const onError = vi.fn();
    const bundle = createDurableCoordination(fake.ns, onError);
    const ip = "203.0.113.77";

    await bundle.authRateLimiters.recoveryGenerate.check(ip);
    await bundle.profileSwitchCap.check(KEY);
    await bundle.ceremonyStores.stepUpOtp.set(KEY, VALUE, 60_000).catch(() => undefined);
    await bundle.ceremonyStores.stepUpOtp.get(KEY).catch(() => undefined);
    await bundle.stepUpJtiStore.consume("jti_secret_value", 60_000).catch(() => undefined);
    await bundle.totpLockoutStore.status(KEY);

    expect(onError).toHaveBeenCalledTimes(6);
    const reported = JSON.stringify(onError.mock.calls);
    for (const secret of [ip, KEY, VALUE.codeHash, "jti_secret_value"]) {
      expect(reported).not.toContain(secret);
    }
    for (const [store, op, detail] of onError.mock.calls) {
      expect(typeof store).toBe("string");
      expect(typeof op).toBe("string");
      expect(Object.keys(detail).toSorted()).toEqual(["durationMs", "retried"]);
    }
  });

  it("counts every call by store, operation and outcome, and nothing else", async () => {
    const counted = vi.spyOn(metrics, "metricCoordinationStoreOp");
    try {
      const fake = createFakeNamespace();
      const bundle = createDurableCoordination(fake.ns, vi.fn());
      await bundle.ceremonyStores.stepUpOtp.set(KEY, VALUE, 60_000);
      await bundle.ceremonyStores.stepUpOtp.get(KEY);
      fake.failWhen(() => true);
      await bundle.authRateLimiters.recoveryGenerate.check("203.0.113.77");

      expect(counted.mock.calls.map(([attrs]) => attrs)).toEqual([
        { store: "step_up_otp", op: "write", result: "ok" },
        { store: "step_up_otp", op: "read", result: "ok" },
        { store: "auth.recovery_generate", op: "increment", result: "error" },
      ]);
      const reported = JSON.stringify(counted.mock.calls);
      for (const secret of ["203.0.113.77", KEY, VALUE.codeHash]) {
        expect(reported).not.toContain(secret);
      }
    } finally {
      counted.mockRestore();
    }
  });
});
