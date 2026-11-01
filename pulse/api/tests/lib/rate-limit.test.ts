import type { RateLimiterBackend } from "@shared/rate-limit";
import { describe, expect, it } from "vitest";

import {
  checkWriteRateLimit,
  createDefaultWriteRateLimiter,
  makeMemoryRateLimiters,
  PULSE_IP_LIMITS,
  PULSE_WRITE_LIMITS,
} from "../../src/lib/rate-limit";
import type { PulseWriteEndpoint } from "../../src/metrics";

/** Spends `limiter`'s budget on `key`, then expects the next hit refused. */
async function expectBudget(limiter: RateLimiterBackend, key: string, budget: number) {
  for (let i = 0; i < budget; i++) {
    // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
    expect(await limiter.check(key), `hit ${i + 1}`).toBe(true);
  }
  expect(await limiter.check(key), "over budget").toBe(false);
}

describe("makeMemoryRateLimiters", () => {
  it("gives every write endpoint its own per-user limiter at its budget", async () => {
    const { write } = makeMemoryRateLimiters();
    for (const endpoint of Object.keys(PULSE_WRITE_LIMITS) as PulseWriteEndpoint[]) {
      // eslint-disable-next-line no-await-in-loop -- one endpoint at a time
      await expectBudget(write[endpoint], "usr_alice", PULSE_WRITE_LIMITS[endpoint].maxRequests);
      // Another user has their own window.
      // eslint-disable-next-line no-await-in-loop -- one endpoint at a time
      expect(await write[endpoint].check("usr_bob"), `${endpoint}, another user`).toBe(true);
    }
  });

  it("refuses discover, share, exposure and the two sign-in buckets past their per-IP budgets", async () => {
    const limiters = makeMemoryRateLimiters();
    for (const name of Object.keys(PULSE_IP_LIMITS) as (keyof typeof PULSE_IP_LIMITS)[]) {
      // eslint-disable-next-line no-await-in-loop -- one limiter at a time
      await expectBudget(limiters[name], "203.0.113.1", PULSE_IP_LIMITS[name].maxRequests);
      // A distinct IP is an independent bucket.
      // eslint-disable-next-line no-await-in-loop -- one limiter at a time
      expect(await limiters[name].check("203.0.113.2"), `${name}, another IP`).toBe(true);
    }
  });

  it("keeps the per-IP budgets at their set values", () => {
    expect(PULSE_IP_LIMITS).toEqual({
      discovery: { maxRequests: 60, windowMs: 60_000 },
      share: { maxRequests: 60, windowMs: 60_000 },
      exposure: { maxRequests: 120, windowMs: 60_000 },
      authStart: { maxRequests: 20, windowMs: 60_000 },
      authSession: { maxRequests: 120, windowMs: 60_000 },
    });
  });

  it("never lets one limiter spend another's budget", async () => {
    const limiters = makeMemoryRateLimiters();
    await expectBudget(limiters.share, "203.0.113.9", PULSE_IP_LIMITS.share.maxRequests);
    expect(await limiters.discovery.check("203.0.113.9")).toBe(true);
    await expectBudget(limiters.write.comms_blast, "usr_carol", 5);
    expect(await limiters.write.event_invite.check("usr_carol")).toBe(true);
  });
});

describe("checkWriteRateLimit", () => {
  it("allows when the backend allows", async () => {
    const limiter: RateLimiterBackend = { check: () => true };
    expect(await checkWriteRateLimit(limiter, "event_create", "usr_alice")).toBe(true);
  });

  it("denies when the backend denies", async () => {
    const limiter: RateLimiterBackend = { check: () => false };
    expect(await checkWriteRateLimit(limiter, "event_create", "usr_alice")).toBe(false);
  });

  it("fails closed (denies) when the backend throws", async () => {
    const limiter: RateLimiterBackend = {
      check: () => {
        throw new Error("backend down");
      },
    };
    expect(await checkWriteRateLimit(limiter, "comms_blast", "usr_alice")).toBe(false);
  });

  it("fails closed when the backend rejects asynchronously", async () => {
    const limiter: RateLimiterBackend = {
      check: () => Promise.reject(new Error("backend timeout")),
    };
    expect(await checkWriteRateLimit(limiter, "rsvp_upsert", "usr_alice")).toBe(false);
  });

  it("keys on the supplied profileId (per-user, not shared)", async () => {
    const limiter = createDefaultWriteRateLimiter("comms_blast"); // 5 / min
    // Exhaust alice's budget.
    for (let i = 0; i < PULSE_WRITE_LIMITS.comms_blast.maxRequests; i++) {
      expect(await checkWriteRateLimit(limiter, "comms_blast", "usr_alice")).toBe(true);
    }
    expect(await checkWriteRateLimit(limiter, "comms_blast", "usr_alice")).toBe(false);
    // Bob is unaffected — keying is per-user.
    expect(await checkWriteRateLimit(limiter, "comms_blast", "usr_bob")).toBe(true);
  });
});

describe("PULSE_WRITE_LIMITS", () => {
  it("matches the locked W4 starting points", () => {
    expect(PULSE_WRITE_LIMITS.event_create).toEqual({ maxRequests: 20, windowMs: 5 * 60_000 });
    expect(PULSE_WRITE_LIMITS.event_update).toEqual({ maxRequests: 60, windowMs: 60_000 });
    expect(PULSE_WRITE_LIMITS.rsvp_upsert).toEqual({ maxRequests: 30, windowMs: 60_000 });
    expect(PULSE_WRITE_LIMITS.event_invite).toEqual({ maxRequests: 10, windowMs: 60_000 });
    expect(PULSE_WRITE_LIMITS.comms_blast).toEqual({ maxRequests: 5, windowMs: 60_000 });
    expect(PULSE_WRITE_LIMITS.series_create).toEqual({ maxRequests: 10, windowMs: 60 * 60_000 });
    expect(PULSE_WRITE_LIMITS.series_update).toEqual({ maxRequests: 60, windowMs: 60 * 60_000 });
    expect(PULSE_WRITE_LIMITS.close_friend_mutate).toEqual({ maxRequests: 60, windowMs: 60_000 });
  });
});
