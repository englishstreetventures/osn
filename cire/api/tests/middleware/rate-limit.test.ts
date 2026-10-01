import { describe, it, expect } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import { Elysia } from "elysia";

import {
  RateLimiterUnbound,
  rateLimitMiddleware,
  rateLimitMiddlewareByUser,
} from "../../src/middleware/rate-limit";
import { appRequest, jsonBody } from "../test-helpers";

function createTestApp(maxRequests: number) {
  const limiter = createRateLimiter({ maxRequests, windowMs: 60_000 });
  return new Elysia({ aot: false })
    .use(rateLimitMiddleware(limiter))
    .post("/test", () => ({ ok: true }));
}

describe("rateLimitMiddleware", () => {
  it("passes through when under limit", async () => {
    const app = createTestApp(5);
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 429 when over limit", async () => {
    const app = createTestApp(2);
    await appRequest(app, "/test", { method: "POST" });
    await appRequest(app, "/test", { method: "POST" });
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: "Too many requests" });
  });

  it("includes Retry-After header on 429", async () => {
    const app = createTestApp(1);
    await appRequest(app, "/test", { method: "POST" });
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  // Fail closed when the IP can't be resolved — a request that reaches the
  // Worker with no/invalid cf-connecting-ip must be denied, never bucketed into
  // a shared fallback key. `appRequest` injects a default CF IP, so we bypass it
  // and hit the app directly with no header to exercise the unresolved path.
  it("returns 429 when no cf-connecting-ip is present (fail closed)", async () => {
    const app = createTestApp(5);
    const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("returns 429 on a malformed cf-connecting-ip (fail closed)", async () => {
    const app = createTestApp(5);
    const res = await app.fetch(
      new Request("http://localhost/test", {
        method: "POST",
        headers: { "cf-connecting-ip": "garbage" },
      }),
    );
    expect(res.status).toBe(429);
  });
});

describe("rateLimitMiddlewareByUser with a limiter that throws", () => {
  // Stands in for `osnAuth`, which derives `osnProfileId` before the limiter.
  function appWith(check: () => Promise<boolean>) {
    return new Elysia({ aot: false })
      .derive({ as: "scoped" }, () => ({ osnProfileId: "usr_a" }))
      .use(rateLimitMiddlewareByUser({ check }))
      .post("/test", () => ({ ok: true }));
  }

  it("answers 503 when the limiter has no binding to count with", async () => {
    const app = appWith(() =>
      Promise.reject(new RateLimiterUnbound("REGISTRY_THUMB_RATE_LIMITER")),
    );
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).toBe(503);
    expect(await jsonBody(res)).toEqual({ error: "rate_limiter_unavailable" });
  });

  it("never lets the request through on any other throw", async () => {
    const app = appWith(() => Promise.reject(new Error("boom")));
    const res = await appRequest(app, "/test", { method: "POST" });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(503);
  });
});
