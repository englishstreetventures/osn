import { describe, it, expect } from "vitest";

import { createMemoryClient, type RedisClient } from "../src/client";
import { checkRedisHealth } from "../src/health";

describe("checkRedisHealth", () => {
  it("returns true for a healthy client", async () => {
    const client = createMemoryClient();
    expect(await checkRedisHealth(client)).toBe(true);
  });

  it("returns false when ping fails", async () => {
    const client: RedisClient = {
      ...createMemoryClient(),
      ping: () => Promise.reject(new Error("connection refused")),
    };
    expect(await checkRedisHealth(client)).toBe(false);
  });

  it("returns false when ping times out", async () => {
    const client: RedisClient = {
      ...createMemoryClient(),
      ping: () => new Promise(() => {}), // never resolves
    };
    expect(await checkRedisHealth(client, 50)).toBe(false);
  });

  it("returns false when ping returns a non-PONG response", async () => {
    const client: RedisClient = {
      ...createMemoryClient(),
      ping: () => Promise.resolve("NOT_PONG"),
    };
    expect(await checkRedisHealth(client)).toBe(false);
  });
});
