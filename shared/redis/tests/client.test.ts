import { describe, it, expect } from "vitest";

import { createMemoryClient } from "../src/client";
import { RATE_LIMIT_SCRIPT } from "../src/rate-limiter";

describe("createMemoryClient — sweep (P-W2)", () => {
  it("evicts expired entries when store exceeds maxEntries", async () => {
    const client = createMemoryClient(3);

    // Fill store with 4 entries — all with 50ms expiry
    await client.eval(RATE_LIMIT_SCRIPT, ["k1"], [10, 50]);
    await client.eval(RATE_LIMIT_SCRIPT, ["k2"], [10, 50]);
    await client.eval(RATE_LIMIT_SCRIPT, ["k3"], [10, 50]);

    // Wait for all entries to expire
    await new Promise((r) => setTimeout(r, 60));

    // This call should trigger sweep and evict expired entries
    await client.eval(RATE_LIMIT_SCRIPT, ["k4"], [10, 60_000]);

    // k1-k3 should be evicted; only k4 should have a value
    expect(await client.get("k1")).toBeNull();
    expect(await client.get("k4")).toBe("1");
  });
});

describe("createMemoryClient — eval script guard (X5)", () => {
  it("accepts the canonical rate-limit script", async () => {
    const client = createMemoryClient();
    await expect(client.eval(RATE_LIMIT_SCRIPT, ["k1"], [10, 1000])).resolves.toBe(1);
  });

  it("throws on any other (unrecognised) Lua script", async () => {
    const client = createMemoryClient();
    await expect(client.eval("return 1", ["k1"], [1, 1000])).rejects.toThrow(/unrecognised script/);
  });

  it("throws on a near-identical-but-different script (no silent rate-limit semantics)", async () => {
    const client = createMemoryClient();
    // A different script that would be catastrophic if it silently got
    // INCR/PEXPIRE behaviour instead of its own.
    const evilDelete = "redis.call('DEL', KEYS[1])";
    await expect(client.eval(evilDelete, ["k1"], [1, 1000])).rejects.toThrow(
      /cannot execute arbitrary Lua/,
    );
  });
});
