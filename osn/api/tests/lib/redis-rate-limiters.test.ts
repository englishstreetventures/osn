import { createMemoryClient } from "@shared/redis";
import { describe, it, expect } from "vitest";

import {
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
  createRedisRecommendationRateLimiters,
} from "../../src/lib/redis-rate-limiters";

describe("createRedisAuthRateLimiters", () => {
  it("enforces begin-endpoint limits (5 req/min)", async () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiters.registerBegin.check("ip1")).toBe(true);
    }
    expect(await limiters.registerBegin.check("ip1")).toBe(false);
  });

  it("enforces complete-endpoint limits (10 req/min)", async () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);

    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiters.registerComplete.check("ip1")).toBe(true);
    }
    expect(await limiters.registerComplete.check("ip1")).toBe(false);
  });

  it("isolates namespaces between endpoints", async () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);

    // Exhaust registerBegin (5 req)
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      await limiters.registerBegin.check("ip1");
    }
    expect(await limiters.registerBegin.check("ip1")).toBe(false);

    // A different slot should still have its own quota
    expect(await limiters.passkeyLoginBegin.check("ip1")).toBe(true);
  });
});

describe("createRedisGraphRateLimiter", () => {
  it("enforces 60 req/min limit", async () => {
    const client = createMemoryClient();
    const limiter = createRedisGraphRateLimiter(client);

    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiter.check("user1")).toBe(true);
    }
    expect(await limiter.check("user1")).toBe(false);
  });

  it("uses a separate namespace from auth rate limiters", async () => {
    const client = createMemoryClient();
    const authLimiters = createRedisAuthRateLimiters(client);
    const graphLimiter = createRedisGraphRateLimiter(client);

    // Exhaust graph limiter for a key
    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      await graphLimiter.check("shared_key");
    }
    expect(await graphLimiter.check("shared_key")).toBe(false);

    // Auth limiter with the same key should be unaffected
    expect(await authLimiters.handleCheck.check("shared_key")).toBe(true);
  });
});

describe("createRedisRecommendationRateLimiters", () => {
  it("enforces 20 req/min on the suggestion fan-out", async () => {
    const client = createMemoryClient();
    const { suggest } = createRedisRecommendationRateLimiters(client);

    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await suggest.check("user1")).toBe(true);
    }
    expect(await suggest.check("user1")).toBe(false);
  });

  it("enforces 60 req/min on search — typeahead needs the looser budget", async () => {
    const client = createMemoryClient();
    const { search } = createRedisRecommendationRateLimiters(client);

    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await search.check("user1")).toBe(true);
    }
    expect(await search.check("user1")).toBe(false);
  });

  it("keeps the two budgets in separate namespaces", async () => {
    // The whole point of the split: exhausting the 20/min fan-out budget must
    // not 429 a user mid-word in the search box. A copy-pasted namespace would
    // collapse both into one bucket and ship green without this.
    const client = createMemoryClient();
    const { suggest, search } = createRedisRecommendationRateLimiters(client);

    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      await suggest.check("shared_key");
    }
    expect(await suggest.check("shared_key")).toBe(false);
    expect(await search.check("shared_key")).toBe(true);
  });
});
