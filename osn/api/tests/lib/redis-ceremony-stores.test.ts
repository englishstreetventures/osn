import type { RedisClient } from "@shared/redis";
import { describe, expect, it } from "vitest";

import { createRedisCeremonyStores } from "../../src/lib/redis-ceremony-stores";

/**
 * The wiring, not the stores themselves — `recovery-lockout-store.test.ts`
 * covers those. What is pinned here: all three lockout counters answer
 * `"unknown"` when the store fails, so each caller refuses the attempt, and
 * they keep separate keys and error names.
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
  it("every counter answers unknown when Redis is unreachable", async () => {
    const wiring = createRedisCeremonyStores(failingClient());
    for (const store of [
      wiring.totpLockoutStore,
      wiring.recoveryOtpLockoutStore,
      wiring.recoveryLockoutStore,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one store at a time
      expect(await store.status("acc_a")).toBe("unknown");
      // eslint-disable-next-line no-await-in-loop -- one store at a time
      expect(await store.recordFailure("acc_a")).toBe("unknown");
    }
  });

  it("keeps the three counters on separate key prefixes", async () => {
    // A shared prefix would let failures at one surface lock another — the
    // cross-surface denial of service `lockoutKey` splits the TOTP scopes to
    // avoid, one level up. Asserted through the client because the prefix is
    // not on the store's public surface.
    const keys: string[] = [];
    const client: RedisClient = {
      eval: async () => 1,
      ping: async () => "PONG",
      get: async (key: string) => {
        keys.push(key);
        return null;
      },
      set: async () => {},
      del: async () => 0,
      quit: async () => {},
    };
    const wiring = createRedisCeremonyStores(client);
    await wiring.recoveryLockoutStore.status("acc_a");
    await wiring.recoveryOtpLockoutStore.status("acc_a");
    await wiring.totpLockoutStore.status("acc_a");
    expect(new Set(keys).size).toBe(3);
  });

  it("routes each counter's errors to its own hook name", async () => {
    const seen: string[] = [];
    const wiring = createRedisCeremonyStores(failingClient(), (store) => seen.push(store));
    await wiring.totpLockoutStore.status("acc_a");
    await wiring.recoveryLockoutStore.status("acc_a");
    await wiring.recoveryOtpLockoutStore.status("acc_a");
    expect(seen).toEqual(["totp_lockout", "recovery_lockout", "recovery_otp_lockout"]);
  });
});
