/**
 * Integration test: auth + graph routes with Redis-backed rate limiters.
 *
 * Verifies that the Redis rate limiter factory from `redis-rate-limiters.ts`
 * produces backends that are accepted by `createAuthRoutes` / `createGraphRoutes`
 * and correctly enforce limits via the in-memory Redis client (same code path
 * as a real Redis backend, minus the network).
 */

import { type Db } from "@osn/db/service";
import { createMemoryClient, createRedisRateLimiter } from "@shared/redis";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import {
  createRedisAuthRateLimiters,
  createRedisGraphRateLimiter,
} from "../../src/lib/redis-rate-limiters";
import { createAuthRoutes } from "../../src/routes/auth";
import { createGraphRoutes } from "../../src/routes/graph";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("auth routes with Redis-backed rate limiters", () => {
  let layer: ReturnType<typeof createTestLayer>;

  beforeEach(() => {
    layer = createTestLayer();
  });

  it("createAuthRoutes accepts Redis-backed rate limiters without error", () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);
    // Should not throw — validates every slot at construction time (S-L2)
    expect(() => createAuthRoutes(config, layer, undefined, limiters)).not.toThrow();
  });

  it("rate limits /register/begin at 5 req/IP/min via Redis backend", async () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);
    const app = createAuthRoutes(config, layer, undefined, limiters);

    const makeRequest = () =>
      app.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.1",
          },
          body: JSON.stringify({
            email: "test@example.com",
            handle: "testuser",
          }),
        }),
      );

    // First 5 requests should succeed (or return 400 due to validation,
    // but NOT 429)
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      const res = await makeRequest();
      expect(res.status).not.toBe(429);
    }

    // 6th request should be rate-limited
    const blocked = await makeRequest();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("rate limits /handle/:handle at 10 req/IP/min via Redis backend", async () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);
    const app = createAuthRoutes(config, layer, undefined, limiters);

    const makeRequest = () =>
      app.handle(
        new Request("http://localhost/handle/testuser", {
          headers: { "X-Forwarded-For": "203.0.113.2" },
        }),
      );

    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      const res = await makeRequest();
      expect(res.status).not.toBe(429);
    }

    const blocked = await makeRequest();
    expect(blocked.status).toBe(429);
  });

  it("different IPs get independent rate limit buckets", async () => {
    const client = createMemoryClient();
    const limiters = createRedisAuthRateLimiters(client);
    const app = createAuthRoutes(config, layer, undefined, limiters);

    // Exhaust IP1's register/begin quota
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      await app.handle(
        new Request("http://localhost/register/begin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "10.0.0.1",
          },
          body: JSON.stringify({ email: "a@b.com", handle: "a" }),
        }),
      );
    }

    // IP2 should still be allowed
    const res = await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.0.0.2",
        },
        body: JSON.stringify({ email: "b@b.com", handle: "b" }),
      }),
    );
    expect(res.status).not.toBe(429);
  });
});

describe("graph routes with Redis-backed rate limiter", () => {
  it("createGraphRoutes accepts Redis-backed rate limiter without error", () => {
    const client = createMemoryClient();
    const limiter = createRedisGraphRateLimiter(client);
    const layer = createTestLayer();
    expect(() => createGraphRoutes(config, layer, undefined, limiter)).not.toThrow();
  });

  it("rate limits graph write at 3 req/user via Redis backend", async () => {
    const client = createMemoryClient();
    // Use a very low limit (3) so the test is fast
    const limiter = createRedisRateLimiter(client, {
      namespace: "graph:write",
      maxRequests: 3,
      windowMs: 60_000,
    });

    const layer = createTestLayer();
    const graphApp = createGraphRoutes(config, layer, undefined, limiter);

    // Register two users so we can attempt a connection
    const auth = createAuthService(config);
    const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
      Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

    const alice = await run(auth.registerProfile("alice@test.com", "alice"));
    await run(auth.registerProfile("bob@test.com", "bob"));
    const tokens = await run(
      auth.issueTokens(alice.id, alice.accountId, alice.email, alice.handle, alice.displayName),
    );

    const makeRequest = () =>
      graphApp.handle(
        new Request("http://localhost/graph/connections/bob", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }),
      );

    // First 3 requests should not be rate-limited (may be 201 or 400 for
    // duplicate connection, but never 429)
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      const res = await makeRequest();
      expect(res.status).not.toBe(429);
    }

    // 4th request should be rate-limited
    const blocked = await makeRequest();
    expect(blocked.status).toBe(429);
  });
});
