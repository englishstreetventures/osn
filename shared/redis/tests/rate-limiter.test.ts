import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryClient, type RedisClient } from "../src/client";
import { createRedisRateLimiter } from "../src/rate-limiter";

describe("createRedisRateLimiter", () => {
  let client: RedisClient;

  beforeEach(() => {
    client = createMemoryClient();
  });

  it("allows requests within the limit", async () => {
    const rl = createRedisRateLimiter(client, {
      namespace: "test",
      maxRequests: 3,
      windowMs: 60_000,
    });

    expect(await rl.check("ip1")).toBe(true);
    expect(await rl.check("ip1")).toBe(true);
    expect(await rl.check("ip1")).toBe(true);
  });

  it("blocks requests exceeding the limit", async () => {
    const rl = createRedisRateLimiter(client, {
      namespace: "test",
      maxRequests: 2,
      windowMs: 60_000,
    });

    expect(await rl.check("ip1")).toBe(true);
    expect(await rl.check("ip1")).toBe(true);
    expect(await rl.check("ip1")).toBe(false);
    expect(await rl.check("ip1")).toBe(false);
  });

  it("tracks keys independently", async () => {
    const rl = createRedisRateLimiter(client, {
      namespace: "test",
      maxRequests: 1,
      windowMs: 60_000,
    });

    expect(await rl.check("ip1")).toBe(true);
    expect(await rl.check("ip2")).toBe(true);
    expect(await rl.check("ip1")).toBe(false);
    expect(await rl.check("ip2")).toBe(false);
  });

  it("resets after window expiry", async () => {
    const rl = createRedisRateLimiter(client, {
      namespace: "test",
      maxRequests: 1,
      windowMs: 50,
    });

    expect(await rl.check("ip1")).toBe(true);
    expect(await rl.check("ip1")).toBe(false);

    await new Promise((r) => setTimeout(r, 60));

    expect(await rl.check("ip1")).toBe(true);
  });

  it("isolates namespaces", async () => {
    const rl1 = createRedisRateLimiter(client, {
      namespace: "auth",
      maxRequests: 1,
      windowMs: 60_000,
    });
    const rl2 = createRedisRateLimiter(client, {
      namespace: "graph",
      maxRequests: 1,
      windowMs: 60_000,
    });

    expect(await rl1.check("ip1")).toBe(true);
    expect(await rl2.check("ip1")).toBe(true);
    expect(await rl1.check("ip1")).toBe(false);
    expect(await rl2.check("ip1")).toBe(false);
  });

  it("returns false (fail-closed) on backend error", async () => {
    const failingClient: RedisClient = {
      ...createMemoryClient(),
      eval: () => Promise.reject(new Error("connection lost")),
    };
    const rl = createRedisRateLimiter(failingClient, {
      namespace: "test",
      maxRequests: 10,
      windowMs: 60_000,
    });

    expect(await rl.check("ip1")).toBe(false);
  });

  it("uses correct Redis key format", async () => {
    // Verify key format by checking that two different namespace+key combos
    // are tracked independently even with the same underlying client store
    const rl = createRedisRateLimiter(client, {
      namespace: "auth:register_begin",
      maxRequests: 1,
      windowMs: 60_000,
    });

    expect(await rl.check("192.168.1.1")).toBe(true);
    expect(await rl.check("192.168.1.1")).toBe(false);
    expect(await rl.check("10.0.0.1")).toBe(true);
  });

  it("denies keys exceeding MAX_KEY_LENGTH (S-M2)", async () => {
    const rl = createRedisRateLimiter(client, {
      namespace: "test",
      maxRequests: 10,
      windowMs: 60_000,
    });

    const longKey = "x".repeat(257);
    expect(await rl.check(longKey)).toBe(false);
  });

  it("throws on invalid namespace characters (S-M2)", () => {
    expect(() =>
      createRedisRateLimiter(client, {
        namespace: "bad namespace!",
        maxRequests: 10,
        windowMs: 60_000,
      }),
    ).toThrow("Invalid rate limiter namespace");
  });

  it("accepts valid namespace characters including dots and hyphens", () => {
    expect(() =>
      createRedisRateLimiter(client, {
        namespace: "auth:register_begin.v2-test",
        maxRequests: 10,
        windowMs: 60_000,
      }),
    ).not.toThrow();
  });
});
