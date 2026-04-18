import { createMemoryClient } from "@shared/redis";
import { describe, it, expect } from "vitest";

import {
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
  createRedisSessionRateLimiters,
} from "../../src/lib/redis-rate-limiters";

describe("createRedisAuthRateLimiters", () => {
  it("returns all 15 rate limiter slots", () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);

    const expectedKeys = [
      "registerBegin",
      "registerComplete",
      "handleCheck",
      "otpBegin",
      "otpComplete",
      "magicBegin",
      "magicVerify",
      "passkeyLoginBegin",
      "passkeyLoginComplete",
      "passkeyRegisterBegin",
      "passkeyRegisterComplete",
      "profileSwitch",
      "profileList",
      "recoveryGenerate",
      "recoveryComplete",
    ] as const;

    for (const key of expectedKeys) {
      expect(limiters[key]).toBeDefined();
      expect(typeof limiters[key].check).toBe("function");
    }

    // Catch additions to the bundle that aren't reflected in expectedKeys —
    // a new slot without a matching entry here means the test is stale.
    expect(Object.keys(limiters).sort()).toEqual([...expectedKeys].sort());
  });

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

    // otpBegin should still have its own quota
    expect(await limiters.otpBegin.check("ip1")).toBe(true);
  });

  it("check() returns a Promise (async-compatible)", () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);
    const result = limiters.registerBegin.check("ip1");
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("createRedisGraphRateLimiter", () => {
  it("returns a valid rate limiter backend", () => {
    const client = createMemoryClient();
    const limiter = createRedisGraphRateLimiter(client);
    expect(typeof limiter.check).toBe("function");
  });

  it("enforces 60 req/min limit", async () => {
    const client = createMemoryClient();
    const limiter = createRedisGraphRateLimiter(client);

    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiter.check("user1")).toBe(true);
    }
    expect(await limiter.check("user1")).toBe(false);
  });

  it("tracks users independently", async () => {
    const client = createMemoryClient();
    const limiter = createRedisGraphRateLimiter(client);

    expect(await limiter.check("user1")).toBe(true);
    expect(await limiter.check("user2")).toBe(true);
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

// ---------------------------------------------------------------------------
// Session management rate limiters (T-M2)
// ---------------------------------------------------------------------------

describe("createRedisSessionRateLimiters", () => {
  it("returns the three expected slots with check() methods", () => {
    const client = createMemoryClient();
    const limiters = createRedisSessionRateLimiters(client);
    const expectedKeys = ["sessionList", "sessionRevoke", "sessionRevokeOthers"] as const;
    for (const key of expectedKeys) {
      expect(limiters[key]).toBeDefined();
      expect(typeof limiters[key].check).toBe("function");
    }
    // Catch additions to the bundle that aren't reflected here — a new slot
    // without a matching entry means the test is stale.
    expect(Object.keys(limiters).toSorted()).toEqual([...expectedKeys].toSorted());
  });

  it("enforces sessionList at 30 req/min", async () => {
    const client = createMemoryClient();
    const limiters = createRedisSessionRateLimiters(client);
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiters.sessionList.check("ip1")).toBe(true);
    }
    expect(await limiters.sessionList.check("ip1")).toBe(false);
  });

  it("enforces sessionRevoke at 10 req/min (stricter than list)", async () => {
    const client = createMemoryClient();
    const limiters = createRedisSessionRateLimiters(client);
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiters.sessionRevoke.check("ip1")).toBe(true);
    }
    expect(await limiters.sessionRevoke.check("ip1")).toBe(false);
  });

  it("enforces sessionRevokeOthers at 5 req/min (strictest — bulk impact)", async () => {
    const client = createMemoryClient();
    const limiters = createRedisSessionRateLimiters(client);
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      expect(await limiters.sessionRevokeOthers.check("ip1")).toBe(true);
    }
    expect(await limiters.sessionRevokeOthers.check("ip1")).toBe(false);
  });

  it("isolates namespaces between the three session slots", async () => {
    const client = createMemoryClient();
    const limiters = createRedisSessionRateLimiters(client);

    // Exhaust revoke (10)
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      await limiters.sessionRevoke.check("shared");
    }
    expect(await limiters.sessionRevoke.check("shared")).toBe(false);

    // The other two slots must still have quota for the same key.
    expect(await limiters.sessionList.check("shared")).toBe(true);
    expect(await limiters.sessionRevokeOthers.check("shared")).toBe(true);
  });

  it("uses a separate namespace from auth rate limiters", async () => {
    const client = createMemoryClient();
    const authLimiters = createRedisAuthRateLimiters(client);
    const sessionLimiters = createRedisSessionRateLimiters(client);

    // Exhaust auth profile_list for a key
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      await authLimiters.profileList.check("shared");
    }
    expect(await authLimiters.profileList.check("shared")).toBe(false);

    // session list uses `session:list` namespace and must be unaffected.
    expect(await sessionLimiters.sessionList.check("shared")).toBe(true);
  });
});
