import { describe, it, expect } from "bun:test";

import { createWorkersRateLimiter } from "./workers-rate-limiter";
import type { WorkersRateLimitBinding } from "./workers-rate-limiter";

describe("createWorkersRateLimiter", () => {
  it("allows the request when the binding reports success", async () => {
    const calls: { key: string }[] = [];
    const binding: WorkersRateLimitBinding = {
      limit: (opts) => {
        calls.push(opts);
        return Promise.resolve({ success: true });
      },
    };
    const limiter = createWorkersRateLimiter(binding);

    await expect(limiter.check("1.2.3.4")).resolves.toBe(true);
    expect(calls).toEqual([{ key: "1.2.3.4" }]);
  });

  it("denies the request when the binding reports failure", async () => {
    const binding: WorkersRateLimitBinding = {
      limit: () => Promise.resolve({ success: false }),
    };
    const limiter = createWorkersRateLimiter(binding);

    await expect(limiter.check("1.2.3.4")).resolves.toBe(false);
  });

  it("fails closed (returns false) when the binding throws", async () => {
    const binding: WorkersRateLimitBinding = {
      limit: () => Promise.reject(new Error("platform error")),
    };
    const limiter = createWorkersRateLimiter(binding);

    await expect(limiter.check("1.2.3.4")).resolves.toBe(false);
  });

  it("fails closed when the binding rejects synchronously", async () => {
    const binding: WorkersRateLimitBinding = {
      limit: () => {
        throw new Error("sync boom");
      },
    };
    const limiter = createWorkersRateLimiter(binding);

    await expect(limiter.check("1.2.3.4")).resolves.toBe(false);
  });
});
