import { describe, it, expect } from "bun:test";

import { createWorkersRateLimiter } from "./workers-rate-limiter";
import type { WorkersRateLimitBinding } from "./workers-rate-limiter";

describe("createWorkersRateLimiter", () => {
  it("allows when the binding reports success", async () => {
    const binding: WorkersRateLimitBinding = {
      limit: async () => ({ success: true }),
    };
    expect(await createWorkersRateLimiter(binding).check("1.2.3.4")).toBe(true);
  });

  it("denies when the binding reports failure (over budget)", async () => {
    const binding: WorkersRateLimitBinding = {
      limit: async () => ({ success: false }),
    };
    expect(await createWorkersRateLimiter(binding).check("1.2.3.4")).toBe(false);
  });

  it("fails CLOSED — a throwing binding denies (never allows)", async () => {
    const binding: WorkersRateLimitBinding = {
      limit: async () => {
        throw new Error("platform error");
      },
    };
    expect(await createWorkersRateLimiter(binding).check("1.2.3.4")).toBe(false);
  });

  it("forwards the key verbatim to the binding", async () => {
    let seen: string | undefined;
    const binding: WorkersRateLimitBinding = {
      limit: async ({ key }) => {
        seen = key;
        return { success: true };
      },
    };
    await createWorkersRateLimiter(binding).check("203.0.113.9");
    expect(seen).toBe("203.0.113.9");
  });
});
