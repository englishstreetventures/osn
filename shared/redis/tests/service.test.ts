import { describe, it, expect } from "@effect/vitest";
import { it as vitestIt } from "vitest";
import { Effect } from "effect";
import { Redis, RedisMemoryLive, _sanitizeCause } from "../src/service";

describe("RedisMemoryLive", () => {
  it.effect("provides the Redis service with a working client", () =>
    Effect.gen(function* () {
      const { client } = yield* Redis;
      const pong = yield* Effect.promise(() => client.ping());
      expect(pong).toBe("PONG");
    }).pipe(Effect.provide(RedisMemoryLive)),
  );

  it.effect("supports get/set/del operations", () =>
    Effect.gen(function* () {
      const { client } = yield* Redis;

      const initial = yield* Effect.promise(() => client.get("key1"));
      expect(initial).toBeNull();

      yield* Effect.promise(() => client.set("key1", "value1"));
      const value = yield* Effect.promise(() => client.get("key1"));
      expect(value).toBe("value1");

      const count = yield* Effect.promise(() => client.del("key1"));
      expect(count).toBe(1);
      const deleted = yield* Effect.promise(() => client.get("key1"));
      expect(deleted).toBeNull();
    }).pipe(Effect.provide(RedisMemoryLive)),
  );

  it.effect("supports set with TTL expiry", () =>
    Effect.gen(function* () {
      const { client } = yield* Redis;

      yield* Effect.promise(() => client.set("ttl-key", "value", 50));
      const before = yield* Effect.promise(() => client.get("ttl-key"));
      expect(before).toBe("value");

      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 60)));
      const after = yield* Effect.promise(() => client.get("ttl-key"));
      expect(after).toBeNull();
    }).pipe(Effect.provide(RedisMemoryLive)),
  );
});

describe("sanitizeCause (S-M3)", () => {
  vitestIt("redacts credentials from redis:// URLs", () => {
    const err = new Error("connect ECONNREFUSED redis://admin:s3cret@redis.example.com:6379");
    expect(_sanitizeCause(err)).toBe(
      "connect ECONNREFUSED redis://[REDACTED]@redis.example.com:6379",
    );
  });

  vitestIt("redacts credentials from rediss:// URLs", () => {
    const err = new Error("failed: rediss://user:pass@host:6380/0");
    expect(_sanitizeCause(err)).toBe("failed: rediss://[REDACTED]@host:6380/0");
  });

  vitestIt("passes through messages without URLs", () => {
    expect(_sanitizeCause(new Error("timeout"))).toBe("timeout");
  });

  vitestIt("handles non-Error causes", () => {
    expect(_sanitizeCause("raw string error")).toBe("raw string error");
  });
});
