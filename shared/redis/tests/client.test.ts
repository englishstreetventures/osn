import type IORedis from "ioredis";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { wrapIoRedis, createMemoryClient, createClientFromUrl } from "../src/client";

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

  describe("eval — EVALSHA-first with eager SHA caching (P-W2)", () => {
    it("tries EVALSHA first, falls back to EVAL on NOSCRIPT (first call)", async () => {
      // First call: EVALSHA fails with NOSCRIPT, falls back to EVAL
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));

      await client.eval("script", ["key1"], [1, 2]);
      expect(mock.evalsha).toHaveBeenCalledOnce();
      expect(mock.eval).toHaveBeenCalledOnce();
    });

    it("uses EVALSHA successfully on subsequent calls (SHA cached by server)", async () => {
      // First call: NOSCRIPT → EVAL loads the script
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));
      await client.eval("script", ["key1"], [1, 2]);

      // Second call: EVALSHA succeeds (script now loaded on server)
      await client.eval("script", ["key2"], [3, 4]);
      expect(mock.evalsha).toHaveBeenCalledTimes(2);
      expect(mock.eval).toHaveBeenCalledOnce(); // no new EVAL
    });

    it("spreads keys and args correctly for EVALSHA", async () => {
      await client.eval("script", ["k1", "k2"], [10, 20]);
      // SHA is computed eagerly from "script"
      expect(mock.evalsha).toHaveBeenCalledWith(expect.any(String), 2, "k1", "k2", 10, 20);
    });

    it("spreads keys and args correctly for EVAL fallback", async () => {
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));
      await client.eval("script", ["k1", "k2"], [10, 20]);
      expect(mock.eval).toHaveBeenCalledWith("script", 2, "k1", "k2", 10, 20);
    });

    it("rethrows non-NOSCRIPT errors from EVALSHA", async () => {
      mock.evalsha.mockRejectedValueOnce(new Error("OOM command not allowed"));

      await expect(client.eval("script", ["k2"], [2])).rejects.toThrow("OOM command not allowed");
    });

    it("caches different scripts independently (P-W2)", async () => {
      // Both scripts succeed on first EVALSHA (already loaded on server)
      await client.eval("script_a", ["k1"], [1]);
      await client.eval("script_b", ["k2"], [2]);
      expect(mock.evalsha).toHaveBeenCalledTimes(2);

      // Subsequent calls reuse cached SHAs
      await client.eval("script_a", ["k3"], [3]);
      await client.eval("script_b", ["k4"], [4]);
      expect(mock.evalsha).toHaveBeenCalledTimes(4);
      // No EVAL calls at all — EVALSHA succeeded every time
      expect(mock.eval).not.toHaveBeenCalled();
    });

    it("computes SHA eagerly — no createHash per EVAL fallback (P-W2)", async () => {
      // Two NOSCRIPT errors for the same script — SHA should only be computed once
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));
      await client.eval("script", ["k1"], [1]);
      expect(mock.eval).toHaveBeenCalledOnce();

      // Simulate Redis restart: NOSCRIPT again on next call
      mock.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));
      await client.eval("script", ["k2"], [2]);
      expect(mock.eval).toHaveBeenCalledTimes(2);

      // The same SHA should be used for both EVALSHA attempts
      const sha1 = mock.evalsha.mock.calls[0][0];
      const sha2 = mock.evalsha.mock.calls[1][0];
      expect(sha1).toBe(sha2);
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

describe("createClientFromUrl", () => {
  it("returns an object satisfying RedisClient", () => {
    // We can't connect to a real server, but we can verify the shape
    const client = createClientFromUrl("redis://localhost:6379");
    expect(typeof client.eval).toBe("function");
    expect(typeof client.ping).toBe("function");
    expect(typeof client.get).toBe("function");
    expect(typeof client.set).toBe("function");
    expect(typeof client.del).toBe("function");
    expect(typeof client.quit).toBe("function");
    // ConnectableRedisClient extras
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    // Clean up the lazy connection (never opened)
    client.disconnect();
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
