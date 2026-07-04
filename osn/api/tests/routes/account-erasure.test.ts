import type { RateLimiterBackend } from "@shared/rate-limit";
import { describe, it, expect, beforeAll } from "vitest";

import {
  createAccountErasureRoutes,
  type AccountErasureRateLimiters,
} from "../../src/routes/account-erasure";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/**
 * S-M5 (osn): the erasure endpoints must key their per-IP limiters via the
 * shared `clientIpConfig` trust policy — spoofable left-most XFF hops must
 * not choose the bucket, and an unresolvable client must be denied rather
 * than pooled into a shared "unknown" bucket (S-M34 posture, mirroring the
 * auth / profile routes).
 */
describe("account-erasure routes — client-IP keying (S-M5)", () => {
  function recordingLimiters(): {
    limiters: AccountErasureRateLimiters;
    keys: string[];
  } {
    const keys: string[] = [];
    const backend: RateLimiterBackend = {
      check: async (key: string) => {
        keys.push(key);
        return true;
      },
    } as RateLimiterBackend;
    return {
      limiters: {
        accountDelete: backend,
        accountRestore: backend,
        accountDeletionStatus: backend,
      },
      keys,
    };
  }

  it("denies with 429 when the client IP is unresolvable (direct mode, no socket peer)", async () => {
    const { limiters, keys } = recordingLimiters();
    // Default clientIpConfig = {} (direct mode). Under app.handle there is
    // no Bun server, so the socket peer is null and XFF is untrusted →
    // UNRESOLVED → deny before the limiter or handler runs.
    const app = createAccountErasureRoutes(config, createTestLayer(), undefined, limiters);
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { "x-forwarded-for": "6.6.6.6" },
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(keys).toEqual([]);
  });

  it("keys the limiter on the trusted XFF hop, ignoring spoofable left-most entries", async () => {
    const { limiters, keys } = recordingLimiters();
    const app = createAccountErasureRoutes(
      config,
      createTestLayer(),
      undefined,
      limiters,
      { secure: false },
      { trustedProxyCount: 1 },
    );
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { "x-forwarded-for": "9.9.9.9, 1.2.3.4" },
      }),
    );
    // Rate limit passed (limiter said yes) → the handler then 401s the
    // missing bearer token; the assertion that matters is the bucket key.
    expect(res.status).toBe(401);
    expect(keys).toEqual(["1.2.3.4"]);
  });

  it("DELETE /account is gated by the same unresolved-IP deny (its own rateLimit call site)", async () => {
    const { limiters, keys } = recordingLimiters();
    const app = createAccountErasureRoutes(config, createTestLayer(), undefined, limiters);
    const res = await app.handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-forwarded-for": "6.6.6.6" },
        body: JSON.stringify({ confirm_handle: "whoever" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(keys).toEqual([]);
  });

  it("returns 429 when the per-IP limiter is exhausted", async () => {
    const denyAll: RateLimiterBackend = {
      check: async () => false,
    } as RateLimiterBackend;
    const app = createAccountErasureRoutes(
      config,
      createTestLayer(),
      undefined,
      { accountDelete: denyAll, accountRestore: denyAll, accountDeletionStatus: denyAll },
      { secure: false },
      { trustedProxyCount: 1 },
    );
    const res = await app.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });
});
