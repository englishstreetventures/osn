import type { RedisClient } from "@shared/redis";
import { describe, expect, it } from "vitest";

import { RECOVERY_LOCKOUT_THRESHOLD } from "../../src/lib/recovery-lockout-store";
import { createRedisCeremonyStores } from "../../src/lib/redis-ceremony-stores";
import { TOTP_LOCKOUT_THRESHOLD } from "../../src/services/auth/constants";

/**
 * The wiring, not the stores themselves — `recovery-lockout-store.test.ts`
 * covers those. What is pinned here is the one asymmetry in this factory: the
 * THREE lockout counters are the same code, and two of them carry the OPPOSITE
 * outage posture to the third. That difference lives in a single
 * `failClosed: true` line each. Drop it and a six-digit code sits behind no
 * throttle at all during a Redis outage, with nothing else in the suite able to
 * notice.
 *
 * Which way round each one goes, and why, is in `recovery-lockout-store.ts`:
 * recovery CODES keep a 64-bit search space behind the counter and fail open;
 * TOTP and the emailed recovery OTP have twenty bits and fail closed.
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

  it("the emailed-OTP recovery counter reports LOCKED when Redis is unreachable", async () => {
    // The same posture as TOTP and for the same reason: the emailed recovery
    // code is six digits, so this counter is not a redundant defence behind a
    // wide search space — it is the only one. Failing open here means an
    // attacker who can reach `/login/recovery/email/complete` during an outage
    // grinds a million-code space at whatever the per-IP limiter allows across
    // a fleet, and walks out with a session that can enrol a passkey.
    //
    // Goes red on: dropping `failClosed: true` from the `recoveryOtpLockoutStore`
    // wiring in `redis-ceremony-stores.ts`.
    const { recoveryOtpLockoutStore } = createRedisCeremonyStores(failingClient());
    expect(await recoveryOtpLockoutStore.isLocked("acc_a")).toBe(true);
    expect(await recoveryOtpLockoutStore.recordFailure("acc_a")).toBe(RECOVERY_LOCKOUT_THRESHOLD);
  });

  it("the recovery-code counter reports UNLOCKED on the same outage", async () => {
    // Deliberately the other way round: recovery codes keep a 64-bit search
    // space behind the counter, so locking every account out during an outage
    // would be a self-inflicted denial of service for no gain.
    const { recoveryLockoutStore } = createRedisCeremonyStores(failingClient());
    expect(await recoveryLockoutStore.isLocked("acc_a")).toBe(false);
    expect(await recoveryLockoutStore.recordFailure("acc_a")).toBe(0);
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
    await wiring.recoveryLockoutStore.isLocked("acc_a");
    await wiring.recoveryOtpLockoutStore.isLocked("acc_a");
    await wiring.totpLockoutStore.isLocked("acc_a");
    expect(new Set(keys).size).toBe(3);
  });

  it("routes each counter's errors to its own hook name", async () => {
    const seen: string[] = [];
    const wiring = createRedisCeremonyStores(failingClient(), (store) => seen.push(store));
    await wiring.totpLockoutStore.isLocked("acc_a");
    await wiring.recoveryLockoutStore.isLocked("acc_a");
    await wiring.recoveryOtpLockoutStore.isLocked("acc_a");
    expect(seen).toEqual(["totp_lockout", "recovery_lockout", "recovery_otp_lockout"]);
  });
});
