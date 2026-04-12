import { describe, it, expect, vi, beforeEach } from "vitest";
import type IORedis from "ioredis";
import { wrapIoRedis, createMemoryClient } from "../src/client";

function createMockIoRedis() {
  return {
    eval: vi.fn<any>().mockResolvedValue(1),
    evalsha: vi.fn<any>().mockResolvedValue(1),
    ping: vi.fn<any>().mockResolvedValue("PONG"),
    get: vi.fn<any>().mockResolvedValue(null),
    set: vi.fn<any>().mockResolvedValue("OK"),
    del: vi.fn<any>().mockResolvedValue(0),
    quit: vi.fn<any>().mockResolvedValue("OK"),
  };
}

describe("wrapIoRedis", () => {
  let mock: ReturnType<typeof createMockIoRedis>;
  let client: ReturnType<typeof wrapIoRedis>;

  beforeEach(() => {
    mock = createMockIoRedis();
    client = wrapIoRedis(mock as unknown as IORedis);
  });

  describe("eval — EVALSHA caching (P-W1)", () => {
    it("uses EVAL on first call and EVALSHA on subsequent calls", async () => {
      await client.eval("script", ["key1"], [1, 2]);
      expect(mock.eval).toHaveBeenCalledOnce();
      expect(mock.evalsha).not.toHaveBeenCalled();

      await client.eval("script", ["key2"], [3, 4]);
      expect(mock.eval).toHaveBeenCalledOnce(); // still only one EVAL
      expect(mock.evalsha).toHaveBeenCalledOnce();
    });

    it("spreads keys and args correctly for EVAL", async () => {
      await client.eval("script", ["k1", "k2"], [10, 20]);
      expect(mock.eval).toHaveBeenCalledWith("script", 2, "k1", "k2", 10, 20);
    });

    it("spreads keys and args correctly for EVALSHA", async () => {
      await client.eval("script", ["k1"], [1]); // prime the cache
      mock.evalsha.mockResolvedValue(42);

      const result = await client.eval("script", ["k2", "k3"], [5, 6]);
      expect(result).toBe(42);
      // SHA is the sha1 of "script", numkeys=2, then keys, then args
      expect(mock.evalsha).toHaveBeenCalledWith(expect.any(String), 2, "k2", "k3", 5, 6);
    });

    it("falls back to EVAL on NOSCRIPT error", async () => {
      await client.eval("script", ["k1"], [1]); // prime cache
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));

      await client.eval("script", ["k2"], [2]); // EVALSHA fails, falls back to EVAL
      expect(mock.eval).toHaveBeenCalledTimes(2);
    });

    it("re-caches SHA after NOSCRIPT fallback", async () => {
      await client.eval("script", ["k1"], [1]); // prime cache
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));

      await client.eval("script", ["k2"], [2]); // fallback to EVAL, re-caches
      expect(mock.eval).toHaveBeenCalledTimes(2);

      await client.eval("script", ["k3"], [3]); // should use EVALSHA again
      expect(mock.evalsha).toHaveBeenCalledTimes(2); // first failed + this one
      expect(mock.eval).toHaveBeenCalledTimes(2); // no new EVAL
    });

    it("rethrows non-NOSCRIPT errors from EVALSHA", async () => {
      await client.eval("script", ["k1"], [1]); // prime cache
      mock.evalsha.mockRejectedValueOnce(new Error("OOM command not allowed"));

      await expect(client.eval("script", ["k2"], [2])).rejects.toThrow("OOM command not allowed");
    });

    it("caches different scripts independently", async () => {
      await client.eval("script_a", ["k1"], [1]);
      await client.eval("script_b", ["k2"], [2]);
      expect(mock.eval).toHaveBeenCalledTimes(2);

      await client.eval("script_a", ["k3"], [3]);
      await client.eval("script_b", ["k4"], [4]);
      expect(mock.evalsha).toHaveBeenCalledTimes(2);
    });
  });

  describe("set", () => {
    it("calls set without PX when no expiry given", async () => {
      await client.set("key", "value");
      expect(mock.set).toHaveBeenCalledWith("key", "value");
    });

    it("calls set with PX when expiry given", async () => {
      await client.set("key", "value", 5000);
      expect(mock.set).toHaveBeenCalledWith("key", "value", "PX", 5000);
    });
  });

  describe("del", () => {
    it("short-circuits on empty keys", async () => {
      const result = await client.del();
      expect(result).toBe(0);
      expect(mock.del).not.toHaveBeenCalled();
    });

    it("delegates to ioredis for non-empty keys", async () => {
      mock.del.mockResolvedValue(2);
      const result = await client.del("k1", "k2");
      expect(result).toBe(2);
      expect(mock.del).toHaveBeenCalledWith("k1", "k2");
    });
  });

  describe("passthrough methods", () => {
    it("delegates ping", async () => {
      const result = await client.ping();
      expect(result).toBe("PONG");
      expect(mock.ping).toHaveBeenCalledOnce();
    });

    it("delegates get", async () => {
      mock.get.mockResolvedValue("val");
      expect(await client.get("k")).toBe("val");
    });

    it("delegates quit", async () => {
      await client.quit();
      expect(mock.quit).toHaveBeenCalledOnce();
    });
  });
});

describe("createMemoryClient — sweep (P-W2)", () => {
  it("evicts expired entries when store exceeds maxEntries", async () => {
    const client = createMemoryClient(3);

    // Fill store with 4 entries — all with 50ms expiry
    await client.eval("s", ["k1"], [10, 50]);
    await client.eval("s", ["k2"], [10, 50]);
    await client.eval("s", ["k3"], [10, 50]);

    // Wait for all entries to expire
    await new Promise((r) => setTimeout(r, 60));

    // This call should trigger sweep and evict expired entries
    await client.eval("s", ["k4"], [10, 60_000]);

    // k1-k3 should be evicted; only k4 should have a value
    expect(await client.get("k1")).toBeNull();
    expect(await client.get("k4")).toBe("1");
  });
});
