import { describe, it, expect } from "bun:test";

import { createRateLimiter, getClientIp } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
  });

  it("blocks requests over the limit", () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false);
    expect(limiter.check("ip-1")).toBe(false);
  });

  it("resets after window expires", () => {
    const originalNow = Date.now;
    let fakeTime = 1000;
    Date.now = () => fakeTime;

    try {
      const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
      expect(limiter.check("ip-1")).toBe(true);
      expect(limiter.check("ip-1")).toBe(false);

      // Advance past the window
      fakeTime = 2001;
      expect(limiter.check("ip-1")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("tracks different keys independently", () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check("ip-a")).toBe(true);
    expect(limiter.check("ip-b")).toBe(true);
    expect(limiter.check("ip-a")).toBe(false);
    expect(limiter.check("ip-b")).toBe(false);
  });

  it("sweep clears expired entries", () => {
    const originalNow = Date.now;
    let fakeTime = 1000;
    Date.now = () => fakeTime;

    try {
      // maxEntries: 0 forces sweep on every check
      const limiter = createRateLimiter({ maxRequests: 10, windowMs: 1000, maxEntries: 0 });
      limiter.check("ip-1");
      limiter.check("ip-2");
      expect(limiter._store.size).toBe(2);

      // Advance past the window so entries expire
      fakeTime = 2001;
      limiter.check("ip-3"); // triggers sweep
      // ip-1 and ip-2 should be swept, only ip-3 remains
      expect(limiter._store.size).toBe(1);
      expect(limiter._store.has("ip-3")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("getClientIp", () => {
  it("prefers cf-connecting-ip", () => {
    const headers = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "5.6.7.8",
    });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });

  it("falls back to x-forwarded-for first entry", () => {
    const headers = new Headers({
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
    });
    expect(getClientIp(headers)).toBe("10.0.0.1");
  });

  it("returns unknown when no IP headers present", () => {
    const headers = new Headers();
    expect(getClientIp(headers)).toBe("unknown");
  });
});
