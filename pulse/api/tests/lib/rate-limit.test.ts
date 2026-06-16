import type { RateLimiterBackend } from "@shared/rate-limit";
import { describe, expect, it } from "vitest";

import {
  checkWriteRateLimit,
  createDefaultWriteRateLimiter,
  PULSE_WRITE_LIMITS,
} from "../../src/lib/rate-limit";

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
        throw new Error("redis down");
      },
    };
    expect(await checkWriteRateLimit(limiter, "comms_blast", "usr_alice")).toBe(false);
  });

  it("fails closed when the backend rejects asynchronously", async () => {
    const limiter: RateLimiterBackend = {
      check: () => Promise.reject(new Error("redis timeout")),
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
