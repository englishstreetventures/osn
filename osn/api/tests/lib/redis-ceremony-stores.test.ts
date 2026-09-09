import type { RedisClient } from "@shared/redis";
import { describe, expect, it } from "vitest";

import { createRedisCeremonyStores } from "../../src/lib/redis-ceremony-stores";
import { TOTP_LOCKOUT_THRESHOLD } from "../../src/services/auth/constants";

/**
 * The wiring, not the stores themselves — `recovery-lockout-store.test.ts`
 * covers those. What is pinned here is the one asymmetry in this factory: the
 * two lockout counters are the same code with OPPOSITE outage postures, and
 * that difference lives in a single `failClosed: true` line. Drop it and TOTP
 * fails open during a Redis outage — six digits behind no throttle at all —
 * with nothing else in the suite able to notice.
 */

// Every command errors, which is what a Redis outage looks like from here.
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

describe("createRedisCeremonyStores lockout postures", () => {
  it("the TOTP counter reports LOCKED when Redis is unreachable", async () => {
    const { totpLockoutStore } = createRedisCeremonyStores(failingClient());
    expect(await totpLockoutStore.isLocked("acc_a")).toBe(true);
    expect(await totpLockoutStore.recordFailure("acc_a")).toBe(TOTP_LOCKOUT_THRESHOLD);
  });

  it("the recovery-code counter reports UNLOCKED on the same outage", async () => {
    // Deliberately the other way round: recovery codes keep a 64-bit search
    // space behind the counter, so locking every account out during an outage
    // would be a self-inflicted denial of service for no gain.
    const { recoveryLockoutStore } = createRedisCeremonyStores(failingClient());
    expect(await recoveryLockoutStore.isLocked("acc_a")).toBe(false);
    expect(await recoveryLockoutStore.recordFailure("acc_a")).toBe(0);
  });

  it("routes each counter's errors to its own hook name", async () => {
    const seen: string[] = [];
    const wiring = createRedisCeremonyStores(failingClient(), (store) => seen.push(store));
    await wiring.totpLockoutStore.isLocked("acc_a");
    await wiring.recoveryLockoutStore.isLocked("acc_a");
    expect(seen).toEqual(["totp_lockout", "recovery_lockout"]);
  });
});
