import { describe, it, expect, vi, beforeEach } from "vitest";

import type { UpstashLike } from "../src/upstash";
import { wrapUpstash } from "../src/upstash";

/**
 * Fake `@upstash/redis` client. Backed by a real `Map` so the contract tests
 * exercise actual round-trips (string-in / string-out) rather than asserting
 * against canned values — mirroring the spirit of the in-memory client test.
 * Constructed as if `automaticDeserialization: false`, i.e. values are stored
 * and returned verbatim as strings.
 */
function createFakeUpstash(): UpstashLike & {
  store: Map<string, string>;
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>();
  const set = vi.fn(async (key: string, value: string, _opts?: { px: number }) => {
    store.set(key, value);
    return "OK";
  });
  const evalFn = vi.fn(
    async (_script: string, _keys: readonly string[], _args: readonly (string | number)[]) => 1,
  );
  return {
    store,
    set,
    eval: evalFn,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async ping() {
      return "PONG";
    },
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    },
  };
}

describe("wrapUpstash", () => {
  let fake: ReturnType<typeof createFakeUpstash>;
  let client: ReturnType<typeof wrapUpstash>;

  beforeEach(() => {
    fake = createFakeUpstash();
    client = wrapUpstash(fake);
  });

  describe("get/set — raw string round-trips (automaticDeserialization: false)", () => {
    it("returns exactly the string that was set", async () => {
      await client.set("k", "fam_abc123");
      expect(await client.get("k")).toBe("fam_abc123");
    });

    it("preserves numeric-looking strings verbatim (not JSON-parsed to numbers)", async () => {
      // The rotated-session-store stores opaque ids; a JSON-parsing client would
      // turn "42" into the number 42 and break the `=== familyId` string compare.
      await client.set("k", "42");
      const got = await client.get("k");
      expect(got).toBe("42");
      expect(typeof got).toBe("string");
    });

    it("returns null for a missing key", async () => {
      expect(await client.get("absent")).toBeNull();
    });
  });

  describe("set — optional PX expiry mapping", () => {
    it("passes { px } when an expiry is given", async () => {
      await client.set("k", "v", 5000);
      expect(fake.set).toHaveBeenCalledWith("k", "v", { px: 5000 });
    });

    it("passes undefined options when no expiry is given", async () => {
      await client.set("k", "v");
      expect(fake.set).toHaveBeenCalledWith("k", "v", undefined);
    });
  });

  describe("eval — numeric return passthrough", () => {
    it("returns the numeric value from the Lua script (rate-limit / counter)", async () => {
      fake.eval.mockResolvedValueOnce(1);
      const result = await client.eval("script", ["k"], [10, 1000]);
      expect(result).toBe(1);
    });

    it("forwards (script, keys, args) unchanged to the Upstash client", async () => {
      await client.eval("the-script", ["k1", "k2"], [10, 1000]);
      expect(fake.eval).toHaveBeenCalledWith("the-script", ["k1", "k2"], [10, 1000]);
    });

    it('passes through a string-typed count (step-up jti `=== "1"` path)', async () => {
      fake.eval.mockResolvedValueOnce("1");
      expect(await client.eval("script", ["k"], [1])).toBe("1");
    });
  });

  describe("del", () => {
    it("short-circuits on empty keys without calling the client", async () => {
      const delSpy = vi.spyOn(fake, "del");
      const result = await client.del();
      expect(result).toBe(0);
      expect(delSpy).not.toHaveBeenCalled();
    });

    it("returns the count of removed keys", async () => {
      await client.set("a", "1");
      await client.set("b", "2");
      expect(await client.del("a", "b", "missing")).toBe(2);
    });
  });

  describe("ping / quit", () => {
    it("delegates ping", async () => {
      expect(await client.ping()).toBe("PONG");
    });

    it("quit is a no-op for the stateless REST transport", async () => {
      await expect(client.quit()).resolves.toBeUndefined();
    });
  });
});
