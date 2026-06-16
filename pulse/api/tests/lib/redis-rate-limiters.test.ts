import { createMemoryClient } from "@shared/redis";
import { describe, expect, it } from "vitest";

import { PULSE_WRITE_LIMITS } from "../../src/lib/rate-limit";
import {
  createRedisDiscoveryRateLimiter,
  createRedisWriteRateLimiters,
} from "../../src/lib/redis-rate-limiters";

describe("createRedisWriteRateLimiters", () => {
  it("returns one limiter per write endpoint, matching PULSE_WRITE_LIMITS keys", () => {
    const client = createMemoryClient();
    const limiters = createRedisWriteRateLimiters(client);

    const expectedKeys = Object.keys(PULSE_WRITE_LIMITS).toSorted();
    expect(Object.keys(limiters).toSorted()).toEqual(expectedKeys);

    for (const key of expectedKeys) {
      const limiter = limiters[key as keyof typeof limiters];
      expect(typeof limiter.check).toBe("function");
    }
  });

  it("enforces the comms_blast budget (5/min) over a memory-backed client", async () => {
    const client = createMemoryClient();
    const limiters = createRedisWriteRateLimiters(client);
    const { maxRequests } = PULSE_WRITE_LIMITS.comms_blast;

    for (let i = 0; i < maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for counting
      expect(await limiters.comms_blast.check("usr_alice")).toBe(true);
    }
    expect(await limiters.comms_blast.check("usr_alice")).toBe(false);
    // Different user → fresh window (per-user keying preserved through Redis).
    expect(await limiters.comms_blast.check("usr_bob")).toBe(true);
  });
});

describe("createRedisDiscoveryRateLimiter", () => {
  it("enforces 60 req/min per key", async () => {
    const client = createMemoryClient();
    const limiter = createRedisDiscoveryRateLimiter(client);

    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for counting
      expect(await limiter.check("1.2.3.4")).toBe(true);
    }
    expect(await limiter.check("1.2.3.4")).toBe(false);
  });
});
