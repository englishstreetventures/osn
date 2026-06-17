import { describe, it, expect } from "vitest";

import { initRedisClientFromEnv } from "../src/redis";

/**
 * Workers-path selector tests. Deliberately NO `@shared/redis/ioredis` mock:
 * `initRedisClientFromEnv` must reach neither ioredis nor the Bun-only health
 * check / `process.exit` path. It only ever returns an Upstash or in-memory
 * client off the request-scoped `env` bindings.
 */
describe("initRedisClientFromEnv", () => {
  it("returns an in-memory client when Upstash bindings are absent", async () => {
    const client = initRedisClientFromEnv({});
    // The in-memory client answers PING synchronously with PONG.
    expect(await client.ping()).toBe("PONG");
  });

  it("returns an in-memory client when only the URL is set", async () => {
    const client = initRedisClientFromEnv({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    });
    expect(await client.ping()).toBe("PONG");
    // In-memory get/set round-trips a string verbatim.
    await client.set("k", "v");
    expect(await client.get("k")).toBe("v");
  });

  it("returns an in-memory client when only the token is set", async () => {
    const client = initRedisClientFromEnv({
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(await client.ping()).toBe("PONG");
  });

  it("constructs an Upstash-backed client when both bindings are present", () => {
    // Upstash's constructor validates the URL/token shape but performs no I/O,
    // so this exercises the selector branch without a network round-trip.
    const client = initRedisClientFromEnv({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(typeof client.eval).toBe("function");
    expect(typeof client.get).toBe("function");
    expect(typeof client.set).toBe("function");
    expect(typeof client.del).toBe("function");
    expect(typeof client.ping).toBe("function");
    expect(typeof client.quit).toBe("function");
    // quit is a no-op for the stateless REST transport.
    return expect(client.quit()).resolves.toBeUndefined();
  });
});
